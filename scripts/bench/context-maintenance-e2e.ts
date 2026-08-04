#!/usr/bin/env bun
/**
 * Context-maintenance E2E benchmark (port of DeepSeek-Reasonix
 * benchmarks/context-maintenance-e2e/main.go) against the real DeepSeek API,
 * applying omp's own pruning primitives.
 *
 * Usage:
 *   bun run scripts/bench/context-maintenance-e2e.ts seed    [--dir <dir>] [--model <id>]
 *   bun run scripts/bench/context-maintenance-e2e.ts resume  [--dir <dir>] [--model <id>]
 *   bun run scripts/bench/context-maintenance-e2e.ts comprehension [--trials N] [--model <id>]
 *
 * Flow (matches Reasonix):
 *   seed  → builds a fat session (20 × 12KB tool results) for two arms
 *           (control / pruned), warms the DeepSeek prefix cache, persists
 *           messages + meta.json.
 *   resume→ after idle past cache TTL: applies omp pruneToolOutputs to the
 *           pruned arm only, one-shots both arms, compares cold-restart
 *           prompt_cache_miss_tokens.
 *   comprehension → N trials: a file's secret number lives only in a tool
 *           result that gets pruned; the model must re-read the file (tool
 *           loop) instead of hallucinating.
 *
 * API key: $DEEPSEEK_API_KEY, else parsed from ~/.omp/agent/models.yml
 * (deepseek provider block). The key is never printed.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { pruneToolOutputs, DEFAULT_PRUNE_CONFIG, type PruneConfig } from "../../packages/agent/src/compaction/pruning";
import type { SessionEntry } from "../../packages/agent/src/compaction/entries";

const DEFAULT_MODEL = "deepseek-v4-flash";
const BASE_URL = "https://api.deepseek.com";
const FAT_RESULTS = 20;
const FAT_BYTES = 12_000;

// ---------------------------------------------------------------------------
// Key resolution (never printed)
// ---------------------------------------------------------------------------

function apiKeyFromModelsYml(text: string): string | undefined {
	// models.yml: providers:\n  deepseek:\n    ... apiKey: sk-...
	let inDeepseek = false;
	for (const line of text.split("\n")) {
		if (/^  deepseek:/.test(line)) {
			inDeepseek = true;
			continue;
		}
		if (inDeepseek) {
			if (/^  \w/.test(line)) break; // next provider block
			const m = line.match(/^ {4}apiKey:\s*(\S+)/);
			if (m) return m[1];
		}
	}
	return undefined;
}

function resolveApiKey(): string {
	const env = process.env.DEEPSEEK_API_KEY;
	if (env) return env;
	const p = join(homedir(), ".omp", "agent", "models.yml");
	if (existsSync(p)) {
		const key = apiKeyFromModelsYml(readFileSync(p, "utf8"));
		if (key) return key;
	}
	console.error("DEEPSEEK_API_KEY not set and no deepseek apiKey found in ~/.omp/agent/models.yml");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// DeepSeek API (non-stream; we only need usage)
// ---------------------------------------------------------------------------

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

interface ChatResult {
	content: string;
	usage: Usage;
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

async function chat(
	key: string,
	model: string,
	messages: unknown[],
	opts: { maxTokens?: number; tools?: unknown[]; toolChoice?: "auto" | "none" } = {},
): Promise<ChatResult> {
	const body: Record<string, unknown> = {
		model,
		messages,
		max_tokens: opts.maxTokens ?? 64,
		temperature: 0,
	};
	if (opts.tools) body.tools = opts.tools;
	if (opts.toolChoice) body.tool_choice = opts.toolChoice;
	if (process.env.CM_DEBUG) console.error("[cm-debug] body head:", JSON.stringify(body).slice(0, 400));
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
	if (process.env.CM_DEBUG) console.error("[cm-debug] status:", res.status);
	if (!res.ok) {
		const err = await res.text().catch(() => "");
		throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 300)}`);
	}
	const data = (await res.json()) as any;
	if (process.env.CM_DEBUG) console.error("[cm-debug] usage raw:", JSON.stringify(data.usage), "| choices:", data.choices?.length);
	const msg = data.choices?.[0]?.message ?? {};
	return {
		content: typeof msg.content === "string" ? msg.content : "",
		usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		toolCalls: (msg.tool_calls ?? []).map((tc: any) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: (() => {
				try {
					return JSON.parse(tc.function.arguments ?? "{}");
				} catch {
					return {};
				}
			})(),
		})),
	};
}

// ---------------------------------------------------------------------------
// Synthetic session construction (omp AgentMessage shapes)
// ---------------------------------------------------------------------------

function fakeGoFile(nonce: string, i: number, size: number): string {
	let b = `// module ${nonce} file${String(i).padStart(2, "0")}\npackage stress\n\n`;
	let line = 0;
	while (b.length < size) {
		b += `func helper_${nonce}_${String(i).padStart(2, "0")}_${String(line).padStart(4, "0")}(x int) int { return x*${line + 3} + ${line * 7} }\n`;
		line++;
	}
	return b;
}

interface Msg {
	role: string;
	content: unknown;
	toolCallId?: string;
	toolName?: string;
	timestamp?: number;
}

function textBlock(text: string) {
	return [{ type: "text", text }];
}

function buildFatSession(nonce: string): Msg[] {
	const msgs: Msg[] = [
		{ role: "user", content: textBlock(`Review every file in module ${nonce} one by one. Keep notes short.`), timestamp: Date.now() },
	];
	for (let i = 0; i < FAT_RESULTS; i++) {
		const id = `c${String(i).padStart(2, "0")}`;
		const name = `src/file${String(i).padStart(2, "0")}.go`;
		msgs.push({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read_file", arguments: { path: name } }],
			timestamp: Date.now(),
		});
		msgs.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "read_file",
			content: textBlock(fakeGoFile(nonce, i, FAT_BYTES)),
			timestamp: Date.now(),
		});
		msgs.push({
			role: "assistant",
			content: textBlock(`Reviewed ${name}.`),
			timestamp: Date.now(),
		});
	}
	return msgs;
}

function toEntries(msgs: Msg[]): SessionEntry[] {
	return msgs.map((m, i) => ({
		type: "message",
		id: `e${i}`,
		parentId: i > 0 ? `e${i - 1}` : null,
		timestamp: new Date(Date.now() + i).toISOString(),
		message: m as any,
	}));
}

function toLlmMessages(msgs: Msg[]): any[] {
	const out: any[] = [];
	for (const m of msgs) {
		if (m.role === "assistant") {
			const text = (m.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			const calls = (m.content as any[]).filter((b) => b.type === "toolCall");
			const msg: any = { role: "assistant", content: text || null };
			// DeepSeek thinking mode: assistant turns must carry reasoning_content
			// back (empty is accepted) or the next request 400s.
			msg.reasoning_content = "";
			if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
			out.push(msg);
		} else if (m.role === "toolResult") {
			const text = (m.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			out.push({ role: "tool", tool_call_id: m.toolCallId!, name: m.toolName ?? "read_file", content: text });
		} else {
			const text = (m.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			out.push({ role: "user", content: text });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]) {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const k = argv[i].slice(2);
			flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
			if (flags[k] !== "") i++;
		}
	}
	return flags;
}

async function seed(dir: string, model: string) {
	const key = resolveApiKey();
	mkdirSync(dir, { recursive: true });
	const meta: any = { seeded_at: new Date().toISOString(), model, nonces: {}, seed_usage: {} };
	for (const arm of ["pruned", "control"]) {
		const nonce = `${arm}${Date.now() % 1_000_000}`;
		const msgs = buildFatSession(nonce);
		const u = await awaitChatWarm(key, model, toLlmMessages(msgs));
		writeFileSync(join(dir, `messages-${arm}.json`), JSON.stringify(msgs, null, 1));
		meta.nonces[arm] = nonce;
		meta.seed_usage[arm] = u;
		console.log(`seeded ${arm.padEnd(7)} prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? 0} miss=${u.prompt_cache_miss_tokens ?? 0}`);
	}
	writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
	console.log(`meta written to ${dir}/meta.json — run \`resume\` after DeepSeek cache TTL (~5 min)`);
}

async function awaitChatWarm(key: string, model: string, messages: any[]) {
	const r = await chat(key, model, messages, { maxTokens: 64 });
	return r.usage;
}

async function resume(dir: string, model: string, pruneSpec?: string) {
	const key = resolveApiKey();
	const pruneConfig: PruneConfig = pruneSpec
		? (() => {
				const [p, m] = pruneSpec.split(":").map(Number);
				return { ...DEFAULT_PRUNE_CONFIG, protectTokens: p, minimumSavings: m };
			})()
		: DEFAULT_PRUNE_CONFIG;
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	const idleMs = Date.now() - new Date(meta.seeded_at).getTime();
	const out: Record<string, Usage & { pruned?: number }> = {};
	for (const arm of ["pruned", "control"]) {
		const msgs = JSON.parse(readFileSync(join(dir, `messages-${arm}.json`), "utf8")) as Msg[];
		let pruned = 0;
		if (arm === "pruned") {
			const entries = toEntries(msgs);
			const res = pruneToolOutputs(entries, pruneConfig);
			pruned = res.prunedCount;
			// entries were mutated in place; recover messages
			const prunedMsgs = entries.map((e) => (e as any).message as Msg);
			msgs.splice(0, msgs.length, ...prunedMsgs);
		}
		const q = "Which file did you review first? Reply with just the path.";
		const r = await chat(key, model, [...toLlmMessages(msgs), { role: "user", content: q }], { maxTokens: 64 });
		out[arm] = { ...r.usage, pruned };
		console.log(`resume ${arm.padEnd(7)} idle=${(idleMs / 60000).toFixed(1)}m pruned=${pruned} prompt=${r.usage.prompt_tokens} hit=${r.usage.prompt_cache_hit_tokens ?? 0} miss=${r.usage.prompt_cache_miss_tokens ?? 0}`);
	}
	const c = out.control;
	const p = out.pruned;
	const report: any = {
		idle_minutes: +(idleMs / 60000).toFixed(1),
		model,
		resume_usage: out,
	};
	if (c.prompt_cache_miss_tokens > 0) {
		report.reduction = {
			control_miss: c.prompt_cache_miss_tokens,
			pruned_miss: p.prompt_cache_miss_tokens,
			pct: +((1 - p.prompt_cache_miss_tokens / c.prompt_cache_miss_tokens) * 100).toFixed(1),
		};
		console.log(`\ncold-restart miss tokens: control=${c.prompt_cache_miss_tokens} pruned=${p.prompt_cache_miss_tokens} (${report.reduction.pct}% reduction)`);
	}
	writeFileSync(join(dir, `resume-${Date.now()}.json`), JSON.stringify(report, null, 2));
}

const READ_TOOL = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read a file's contents from the workspace",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
};

async function comprehension(trials: number, model: string) {
	const key = resolveApiKey();
	let pass = 0;
	for (let t = 0; t < trials; t++) {
		const dir = join(tmpdir(), `cm-e2e-${Date.now()}-${t}`);
		mkdirSync(dir, { recursive: true });
		const secret = String(1000 + (Date.now() % 9000));
		const content = `package cfg\n\n// retention floor, milliseconds\nconst cacheRetentionFloor = ${secret}\n` + "// padding line filler for prune eligibility\n".repeat(400);
		writeFileSync(join(dir, "config.go"), content);

		const msgs: Msg[] = [
			{ role: "user", content: textBlock("Read config.go and note its constants."), timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read_file", arguments: { path: "config.go" } }], timestamp: Date.now() },
			{ role: "toolResult", toolCallId: "r1", toolName: "read_file", content: textBlock(content), timestamp: Date.now() },
			{ role: "assistant", content: textBlock("Noted the constants in config.go."), timestamp: Date.now() },
		];
		for (let i = 0; i < 4; i++) {
			msgs.push({ role: "user", content: textBlock(`ack ${i}`), timestamp: Date.now() });
			msgs.push({ role: "assistant", content: textBlock("ok"), timestamp: Date.now() });
		}

		const entries = toEntries(msgs);
		const pruneConfig: PruneConfig = { ...DEFAULT_PRUNE_CONFIG, protectTokens: 0, minimumSavings: 10 };
		const st = pruneToolOutputs(entries, pruneConfig);
		if (st.prunedCount === 0) {
			console.error(`trial ${t}: prune did not fire (saved=${st.tokensSaved})`);
			rmSync(dir, { recursive: true, force: true });
			continue;
		}
		const prunedMsgs = entries.map((e) => (e as any).message as Msg);

		// Two-stage tool loop: model may call read_file to recover the pruned content.
		let reRead = false;
		let answered = false;
		let err: string | undefined;
		try {
			const llm = toLlmMessages(prunedMsgs);
			const q = "What is the exact numeric value of cacheRetentionFloor in config.go? Reply with just the number.";
			let r = await chat(key, model, [...llm, { role: "user", content: q }], { maxTokens: 2048, tools: [READ_TOOL], toolChoice: "auto" });
			let rounds = 0;
			while (r.toolCalls.length && rounds < 3) {
				for (const tc of r.toolCalls) {
					if (tc.name === "read_file") {
						reRead = true;
						let body: string;
						try {
							const p = resolve(dir, String(tc.arguments.path ?? ""));
							body = readFileSync(p, "utf8");
						} catch (e: any) {
							body = `error: ${e.message}`;
						}
						llm.push({ role: "assistant", content: null, reasoning_content: "", tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] });
						llm.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: body });
					}
				}
				r = await chat(key, model, [...llm, { role: "user", content: q }], { maxTokens: 2048, tools: [READ_TOOL], toolChoice: "auto" });
				rounds++;
			}
			if (r.content.includes(secret)) answered = true;
		} catch (e: any) {
			err = String(e);
		}
		const ok = !err && reRead && answered;
		if (ok) pass++;
		console.log(`trial ${t}: prune_fired=${st.prunedCount} re_read=${reRead} answered=${answered}${err ? ` err=${err.slice(0, 120)}` : ""}`);
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(`\ncomprehension: ${pass}/${trials} passed`);
	if (pass < trials) process.exit(1);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const dir = flags.dir ?? "scripts/bench/run/cm-e2e";
const model = flags.model ?? DEFAULT_MODEL;
const trials = Number(flags.trials ?? 5);
const pruneSpec = flags.prune || undefined;

switch (cmd) {
	case "seed":
		await seed(dir, model);
		break;
	case "resume":
		await resume(dir, model, pruneSpec);
		break;
	case "comprehension":
		await comprehension(trials, model);
		break;
	default:
		console.error("usage: context-maintenance-e2e.ts <seed|resume|comprehension> [--dir <dir>] [--model <id>] [--trials N] [--prune protectTokens:minimumSavings]");
		process.exit(1);
}
