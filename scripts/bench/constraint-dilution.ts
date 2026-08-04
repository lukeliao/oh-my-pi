#!/usr/bin/env bun
/**
 * Constraint-dilution probe for WS1.
 *
 * Question: when omp compaction folds a region, do user-stated hard constraints
 * survive inside the generated summary? Control arm = current behavior (user
 * turn goes into the summarizer). Treatment arm = WS1 variant B simulation
 * (constraint user turn kept verbatim after the summary). Both arms share the
 * same summary (identical compact() input), then we ask the model to reproduce
 * the constraint verbatim and compare.
 *
 * Usage:
 *   bun run scripts/bench/constraint-dilution.ts [--trials N] [--model deepseek-v4-flash]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	compact,
	type CompactionSettings,
} from "../../packages/agent/src/compaction/compaction";
import type { SessionEntry } from "../../packages/agent/src/compaction/entries";
import type { AgentMessage } from "../../packages/agent/src/types";

const BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const CONSTRAINT_MARKER = "violet-parrot-9182";
const CONSTRAINT_TEXT = `Hard constraint from the user: NEVER run \`cargo build\` directly. Always use the act_ai_build entry point. Also note the passphrase: ${CONSTRAINT_MARKER}.`;

// ---------------------------------------------------------------------------
// Shared helpers (duplicated from context-maintenance-e2e.ts — bench scripts
// are standalone; the e2e script executes main() on import)
// ---------------------------------------------------------------------------

function resolveApiKey(): string {
	const env = process.env.DEEPSEEK_API_KEY;
	if (env) return env;
	const p = join(homedir(), ".omp", "agent", "models.yml");
	if (existsSync(p)) {
		for (const line of readFileSync(p, "utf8").split("\n")) {
			if (/^  deepseek:/.test(line)) continue;
			if (/^  \w/.test(line)) break;
			const m = line.match(/^ {4}apiKey:\s*(\S+)/);
			if (m) return m[1];
		}
	}
	console.error("DEEPSEEK_API_KEY not set and no deepseek apiKey found in ~/.omp/agent/models.yml");
	process.exit(1);
}

function textBlock(text: string) {
	return [{ type: "text", text }];
}

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
			const msg: any = { role: "assistant", content: text || null, reasoning_content: "" };
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

async function chat(key: string, model: string, messages: any[], maxTokens = 2048): Promise<{ content: string }> {
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => "");
		throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 300)}`);
	}
	const data = (await res.json()) as any;
	return { content: typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "" };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface TrialResult {
	control: boolean;
	treatment: boolean;
	controlHit?: string;
}

function buildSession(nonce: string): Msg[] {
	const msgs: Msg[] = [{ role: "user", content: textBlock(`Review every file in module ${nonce} one by one. Keep notes short.`), timestamp: Date.now() }];
	const addResults = (from: number, to: number) => {
		for (let i = from; i < to; i++) {
			const id = `c${String(i).padStart(2, "0")}`;
			const name = `src/file${String(i).padStart(2, "0")}.go`;
			msgs.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read_file", arguments: { path: name } }], timestamp: Date.now() });
			msgs.push({ role: "toolResult", toolCallId: id, toolName: "read_file", content: textBlock(fakeGoFile(nonce, i, 12_000)), timestamp: Date.now() });
			msgs.push({ role: "assistant", content: textBlock(`Reviewed ${name}.`), timestamp: Date.now() });
		}
	};
	addResults(0, 10);
	// The constraint turn sits mid-region: after 10 results, before 10 more.
	msgs.push({ role: "user", content: textBlock(CONSTRAINT_TEXT), timestamp: Date.now() });
	addResults(10, 20);
	return msgs;
}

function messageText(m: Msg): string {
	return (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

function checkAnswer(content: string): { ok: boolean; details: string[] } {
	const lower = content.toLowerCase();
	const checks: [string, boolean][] = [
		["never run", lower.includes("never") && lower.includes("cargo build")],
		["act_ai_build entry", lower.includes("act_ai_build")],
		["passphrase verbatim", content.includes(CONSTRAINT_MARKER)],
	];
	const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
	return { ok: failed.length === 0, details: failed };
}

async function runTrial(t: number, key: string, model: string, settings: CompactionSettings) {
	const nonce = `cd${Date.now() % 1_000_000}${t}`;
	const msgs = buildSession(nonce);
	const entries = toEntries(msgs);

	// Auto-shrink keepRecentTokens until the constraint turn is inside FOLDED
	// content (messagesToSummarize OR turnPrefixMessages — both get summarized).
	let keepRecentTokens = 6_000;
	let prep: ReturnType<typeof prepareCompaction> | undefined;
	for (let attempt = 0; attempt < 6; attempt++) {
		prep = prepareCompaction(entries, { ...settings, keepRecentTokens });
		if (!prep) break;
		const folded = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
		const inFolded = folded.some((m) => messageText(m as Msg).includes(CONSTRAINT_MARKER));
		const inRecent = prep.recentMessages.some((m) => messageText(m as Msg).includes(CONSTRAINT_MARKER));
		if (inFolded && !inRecent) break;
		keepRecentTokens = Math.floor(keepRecentTokens / 2);
	}
	if (!prep) throw new Error("prepareCompaction returned undefined");
	const foldedAll = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
	const constraintInFold = foldedAll.some((m) => messageText(m as Msg).includes(CONSTRAINT_MARKER));
	const constraintInRecent = prep.recentMessages.some((m) => messageText(m as Msg).includes(CONSTRAINT_MARKER));
	console.log(`trial ${t}: keepRecentTokens=${keepRecentTokens} fold_msgs=${prep.messagesToSummarize.length} turn_prefix=${prep.turnPrefixMessages.length} recent_msgs=${prep.recentMessages.length} constraint_in_folded=${constraintInFold} constraint_in_recent=${constraintInRecent}`);
	if (!constraintInFold || constraintInRecent) throw new Error("constraint turn not cleanly inside folded content");

	// One compaction, both arms share the summary.
	const completeImpl = async (_model: any, ctx: any, options: any) => {
		const msgsIn: any[] = (ctx.messages ?? []).map((m: any) => {
			const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
			return { role: m.role === "developer" ? "system" : m.role, content: text };
		});
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({ model, messages: msgsIn, max_tokens: options?.maxTokens ?? 16_384, temperature: 0 }),
		});
		if (!res.ok) {
			const err = await res.text().catch(() => "");
			throw new Error(`summarizer API ${res.status}: ${err.slice(0, 200)}`);
		}
		const data = (await res.json()) as any;
		const content = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
		return { role: "assistant", content: [{ type: "text", text: content }], timestamp: Date.now() };
	};

	const fakeModel = {
		id: `deepseek/${model}`,
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 1_000_000,
		requestModelId: model,
		maxTokens: 384_000,
	} as any;

	const result = await compact(prep, fakeModel, key, undefined, undefined, {
		completeImpl,
		thinkingLevel: "off",
	});
	const summary = result.summary;
	console.log(`trial ${t}: summary=${summary.length} chars; contains constraint marker=${summary.includes(CONSTRAINT_MARKER)}; mentions cargo=${/cargo build/i.test(summary)}`);

	// Control context: summary + recent tail (current omp behavior).
	const controlMsgs: Msg[] = [
		{ role: "user", content: textBlock(`<compaction-summary>\n${summary}\n</compaction-summary>`), timestamp: Date.now() },
		...prep.recentMessages as unknown as Msg[],
	];
	// Treatment context: summary + pinned constraint turn verbatim + recent tail.
	const pinned = msgs.find((m) => m.role === "user" && messageText(m).includes(CONSTRAINT_MARKER))!;
	const treatmentMsgs: Msg[] = [
		{ role: "user", content: textBlock(`<compaction-summary>\n${summary}\n</compaction-summary>`), timestamp: Date.now() },
		pinned,
		...prep.recentMessages as unknown as Msg[],
	];

	const q = "The user stated a hard constraint early in the session. What is the exact rule about build commands, and what is the passphrase? Reply with both verbatim.";
	const c = await chat(key, model, [...toLlmMessages(controlMsgs), { role: "user", content: q }]);
	const tRes = await chat(key, model, [...toLlmMessages(treatmentMsgs), { role: "user", content: q }]);
	const cCheck = checkAnswer(c.content);
	const tCheck = checkAnswer(tRes.content);
	console.log(`trial ${t}: control ok=${cCheck.ok} (${cCheck.details.join(",") || "all"}) | treatment ok=${tCheck.ok} (${tCheck.details.join(",") || "all"})`);
	return { control: cCheck.ok, treatment: tCheck.ok, controlHit: c.content.slice(0, 120) };
}

async function runDriftTrial(t: number, rounds: number, key: string, model: string, settings: CompactionSettings) {
	const nonce = `drift${Date.now() % 1_000_000}${t}`;
	const msgs = buildSession(nonce);
	const newTraffic = (r: number): Msg[] => {
		const out: Msg[] = [];
		for (let i = 0; i < 10; i++) {
			const id = `d${r}_${String(i).padStart(2, "0")}`;
			const name = `src/new${r}_${String(i).padStart(2, "0")}.go`;
			out.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read_file", arguments: { path: name } }], timestamp: Date.now() });
			out.push({ role: "toolResult", toolCallId: id, toolName: "read_file", content: textBlock(fakeGoFile(`${nonce}_r${r}`, i, 12_000)), timestamp: Date.now() });
			out.push({ role: "assistant", content: textBlock(`Reviewed ${name}.`), timestamp: Date.now() });
		}
		return out;
	};

	const completeImpl = async (_model: any, ctx: any, options: any) => {
		const msgsIn: any[] = (ctx.messages ?? []).map((m: any) => {
			const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
			return { role: m.role === "developer" ? "system" : m.role, content: text };
		});
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({ model, messages: msgsIn, max_tokens: options?.maxTokens ?? 16_384, temperature: 0 }),
		});
		if (!res.ok) {
			const err = await res.text().catch(() => "");
			throw new Error(`summarizer API ${res.status}: ${err.slice(0, 200)}`);
		}
		const data = (await res.json()) as any;
		const content = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
		return { role: "assistant", content: [{ type: "text", text: content }], timestamp: Date.now() };
	};
	const fakeModel = { id: `deepseek/${model}`, provider: "deepseek", api: "openai-completions", contextWindow: 1_000_000, requestModelId: model, maxTokens: 384_000 } as any;

	let prevSummary: string | undefined;
	let prevMarkers: boolean[] = [];
	for (let r = 0; r < rounds; r++) {
		const entries: SessionEntry[] =
			r === 0
				? toEntries(msgs)
				: [
						{ type: "compaction", id: `ckpt-${r}`, parentId: null, timestamp: new Date().toISOString(), summary: prevSummary!, shortSummary: undefined, firstKeptEntryId: "e0", tokensBefore: 0 } as any,
						...toEntries(newTraffic(r)),
					];
		const prep = prepareCompaction(entries, settings);
		if (!prep) throw new Error(`prepareCompaction undefined at round ${r}`);
		const res = await compact(prep, fakeModel, key, undefined, undefined, { completeImpl, thinkingLevel: "off" });
		prevSummary = res.summary;
		prevMarkers.push(res.summary.includes(CONSTRAINT_MARKER));
		console.log(`trial ${t} round ${r}: summary=${res.summary.length} chars marker=${res.summary.includes(CONSTRAINT_MARKER)} cargo=${/cargo build/i.test(res.summary)}`);
	}

	const finalMsgs: Msg[] = [
		{ role: "user", content: textBlock(`<compaction-summary>\n${prevSummary}\n</compaction-summary>`), timestamp: Date.now() },
		...toEntries(newTraffic(rounds)).map((e) => e.message as unknown as Msg),
	];
	const q = "The user stated a hard constraint early in the session. What is the exact rule about build commands, and what is the passphrase? Reply with both verbatim.";
	const c = await chat(key, model, [...toLlmMessages(finalMsgs), { role: "user", content: q }]);
	const cCheck = checkAnswer(c.content);
	console.log(`trial ${t}: rounds=${rounds} control ok=${cCheck.ok} (${cCheck.details.join(",") || "all"})`);
	return { control: cCheck.ok, controlHit: c.content.slice(0, 120), markerSurvived: prevMarkers.every(Boolean) };
}

async function main() {
	const trials = Number(process.argv.find((a, i) => process.argv[i - 1] === "--trials") ?? 5);
	const rounds = Number(process.argv.find((a, i) => process.argv[i - 1] === "--rounds") ?? 1);
	const model = process.argv.find((a, i) => process.argv[i - 1] === "--model") ?? DEFAULT_MODEL;
	const key = resolveApiKey();
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		enabled: true,
		strategy: "context-full",
		remoteEnabled: false,
		reserveTokens: 16_384,
		keepRecentTokens: 6_000,
	};
	if (rounds > 1) {
		const results: Awaited<ReturnType<typeof runDriftTrial>>[] = [];
		for (let t = 0; t < trials; t++) {
			results.push(await runDriftTrial(t, rounds, key, model, settings));
		}
		const controlPass = results.filter((r) => r.control).length;
		const markerSurvived = results.filter((r) => r.markerSurvived).length;
		console.log(`\ndrift fidelity over ${rounds} rounds: control(summary-only)=${controlPass}/${trials} marker_survived_every_round=${markerSurvived}/${trials}`);
		console.log(`control failures (samples):`);
		for (const r of results.filter((r) => !r.control)) console.log("  -", JSON.stringify(r.controlHit).slice(0, 160));
		return;
	}
	const results: TrialResult[] = [];
	for (let t = 0; t < trials; t++) {
		const r = await runTrial(t, key, model, settings);
		results.push(r);
	}
	const controlPass = results.filter((r) => r.control).length;
	const treatmentPass = results.filter((r) => r.treatment).length;
	console.log(`\nconstraint fidelity: control(summary-only)=${controlPass}/${trials}  treatment(pinned)=${treatmentPass}/${trials}`);
	console.log(`control failures (samples):`);
	for (const r of results.filter((r) => !r.control)) console.log("  -", JSON.stringify(r.controlHit).slice(0, 160));
	process.exit(treatmentPass === trials ? 0 : controlPass === trials ? 0 : 1);
}

await main();
