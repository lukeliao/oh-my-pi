import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const exeSuffix = process.platform === "win32" ? ".exe" : "";

interface ResolveBinaryOk {
	ok: true;
	path: string;
}
interface ResolveBinaryErr {
	ok: false;
	message: string;
}
type ResolveBinaryResult = ResolveBinaryOk | ResolveBinaryErr;

/**
 * Resolve the `semble_rs` binary path with this precedence:
 * 1. SEMLE_RS_BIN → error (spelling guard).
 * 2. SEMBLE_RS_BIN → must point to an existing file.
 * 3. Relative path to release build sibling of oh-my-pi.
 * 4. Relative path to debug build sibling.
 * 5. Fall back to bare `semble_rs` on PATH (let spawn report ENOENT).
 */
function resolveSembleBinary(
	env: typeof process.env = process.env,
): ResolveBinaryResult {
	if (env.SEMLE_RS_BIN !== undefined) {
		return {
			ok: false,
			message:
				"Unsupported SEMLE_RS_BIN is set; use SEMBLE_RS_BIN instead.",
		};
	}
	if (env.SEMBLE_RS_BIN !== undefined) {
		if (!fs.existsSync(env.SEMBLE_RS_BIN)) {
			return {
				ok: false,
				message: `SEMBLE_RS_BIN does not point to an existing file: ${env.SEMBLE_RS_BIN}`,
			};
		}
		return { ok: true, path: env.SEMBLE_RS_BIN };
	}

	// import.meta.dir is `.omp/tools/semble-rs/` inside oh-my-pi
	const releasePath = path.resolve(
		import.meta.dir,
		"../../../../semble_rs/target/release/semble_rs" + exeSuffix,
	);
	if (fs.existsSync(releasePath)) {
		return { ok: true, path: releasePath };
	}

	const debugPath = path.resolve(
		import.meta.dir,
		"../../../../semble_rs/target/debug/semble_rs" + exeSuffix,
	);
	if (fs.existsSync(debugPath)) {
		return { ok: true, path: debugPath };
	}

	return { ok: true, path: "semble_rs" + exeSuffix };
}

interface ResolveModelOk {
	ok: true;
	path: string;
}
interface ResolveModelErr {
	ok: false;
	message: string;
}
type ResolveModelResult = ResolveModelOk | ResolveModelErr;

/**
 * Resolve the local Model2Vec path. Semantic commands require a local model
 * and must NOT trigger implicit HuggingFace downloads.
 */
function resolveModelPath(
	paramsModelPath?: string,
	env: typeof process.env = process.env,
): ResolveModelResult {
	const resolved = paramsModelPath ?? env.SEMBLE_MODEL_PATH;
	if (!resolved) {
		return {
			ok: false,
			message:
				"SEMBLE_MODEL_PATH or model_path is required; semantic semble_rs tools must use a local Model2Vec model path and must not trigger implicit HuggingFace download.",
		};
	}
	if (!fs.existsSync(resolved)) {
		return {
			ok: false,
			message: `Local semble_rs model path does not exist: ${resolved}`,
		};
	}
	return { ok: true, path: resolved };
}

// ---------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------

interface BuildArgsResult {
	args: string[];
	stdinText?: string;
}

/**
 * Build CLI args for a given `semble_rs` command and typed params.
 * Also returns optional stdin text for commands that pipe input.
 * Exported for tests via `buildSembleArgsForTest`.
 */
function buildSembleArgs(
	toolName: string,
	params: Record<string, unknown>,
	modelPath?: string,
): BuildArgsResult {
	switch (toolName) {
		case "digest": {
			const p = params as {
				input?: string;
				file?: string;
				format?: string;
				show_format?: boolean;
			};
			const args = ["digest", "--format", p.format ?? "auto"];
			if (p.show_format) args.push("--show-format");
			if (p.file) {
				args.push(p.file);
			}
			return { args, stdinText: p.file ? undefined : p.input };
		}
		case "search": {
			const p = params as {
				query: string;
				path: string;
				top_k: number;
				mode: string;
				include_text_files: boolean;
			};
			const args = [
				"search",
				p.query,
				p.path,
				"--top-k",
				String(p.top_k),
			];
			if (modelPath) args.push("--model", modelPath);
			switch (p.mode) {
				case "outline":
					args.push("--outline");
					break;
				case "compact":
					args.push("--compact");
					break;
				case "group":
					args.push("--group");
					break;
				case "json":
					args.push("--json");
					break;
				case "json_strip":
					args.push("--json", "--strip");
					break;
				case "full":
					break;
			}
			if (p.include_text_files) args.push("--include-text-files");
			return { args };
		}
		case "deps":
		case "impact": {
			const p = params as {
				file_path: string;
				path: string;
				mode: string;
				max_depth?: number;
			};
			const args = [toolName, p.file_path, p.path];
			switch (p.mode) {
				case "json":
					args.push("--json");
					break;
				case "dot":
					args.push("--dot");
					break;
				case "tree":
					args.push("--tree");
					if (p.max_depth !== undefined)
						args.push("--max-depth", String(p.max_depth));
					break;
				case "text":
					break;
			}
			return { args };
		}
		case "tree": {
			const p = params as {
				path: string;
				dirs_only: boolean;
				max_depth?: number;
				symbols: boolean;
				lang?: string[];
				include_text_files: boolean;
			};
			const args = ["tree", p.path];
			if (p.dirs_only) args.push("-d");
			if (p.max_depth !== undefined)
				args.push("--max-depth", String(p.max_depth));
			if (p.symbols) args.push("--symbols");
			if (p.lang && p.lang.length > 0)
				args.push("--lang", p.lang.join(","));
			if (p.include_text_files) args.push("--include-text-files");
			return { args };
		}
		case "find-related": {
			const p = params as {
				file_path: string;
				line: number;
				path: string;
				top_k: number;
				include_text_files: boolean;
				json: boolean;
			};
			const args = [
				"find-related",
				p.file_path,
				String(p.line),
				p.path,
				"--top-k",
				String(p.top_k),
			];
			if (modelPath) args.push("--model", modelPath);
			if (p.include_text_files) args.push("--include-text-files");
			if (p.json) args.push("--json");
			return { args };
		}
		case "find-pattern": {
			const p = params as {
				pattern: string;
				path: string;
				lang?: string;
				compact: boolean;
			};
			const args = ["find-pattern", p.pattern, p.path];
			if (p.lang) args.push("--lang", p.lang);
			if (p.compact) args.push("--compact");
			return { args };
		}
		case "encode": {
			const p = params as {
				text?: string;
				file?: string;
				lines?: string[];
			};
			const args = ["encode"];
			if (modelPath) args.push("--model", modelPath);
			if (p.file) {
				args.push("--file", p.file);
				return { args };
			}
			if (p.text !== undefined) {
				args.push(p.text);
				return { args };
			}
			const lineText = p.lines!.join("\n") + "\n";
			return { args, stdinText: lineText };
		}
		default:
			return { args: [] };
	}
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const SEMANTIC_TIMEOUT_MS = 180_000;

const SEMANTIC_COMMANDS: Record<string, true> = {
	search: true,
	"find-related": true,
};

interface RunSembleOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	stdinText?: string;
	signal?: AbortSignal;
}

interface RunSembleSuccess {
	isError: false;
	text: string;
	details: {
		command: string;
		args: string[];
		exitCode: number;
		stderr: string;
	};
}

interface RunSembleError {
	isError: true;
	text: string;
	details: {
		command: string;
		args: string[];
		exitCode: number | null;
		stderr: string;
	};
}

type RunSembleResult = RunSembleSuccess | RunSembleError;

async function runSemble(
	toolName: string,
	params: Record<string, unknown>,
	modelPath: string | undefined,
	options: RunSembleOptions,
): Promise<RunSembleResult> {
	const binaryResult = resolveSembleBinary();
	if (!binaryResult.ok) {
		return errorResult(
			toolName,
			params,
			binaryResult.message,
			null,
			"",
		);
	}

	const { args, stdinText } = buildSembleArgs(toolName, params, modelPath);
	const binary = binaryResult.path;
	const cwd = options.cwd;
	const env: Record<string, string> = { ...process.env };
	if (options.env) {
		for (const [k, v] of Object.entries(options.env)) {
			if (v === undefined) delete env[k];
			else env[k] = v;
		}
	}

	const proc = Bun.spawn([binary, ...args], {
		cwd,
		env,
		stdin: stdinText !== undefined ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Write stdin if present (Bun.spawn stdin is a FileSink)
	if (stdinText !== undefined) {
		proc.stdin.write(new TextEncoder().encode(stdinText));
		proc.stdin.end();
	}

	const timeoutMs = SEMANTIC_COMMANDS[toolName]
		? SEMANTIC_TIMEOUT_MS
		: DEFAULT_TIMEOUT_MS;

	let timedOut = false;
	let aborted = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	const onAbort = () => {
		aborted = true;
		proc.kill();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let stdout = "";
	let stderr = "";
	try {
		[stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
	} catch {
		// process killed — capture what we got
	}
	const exitCode = await proc.exited;

	clearTimeout(timeoutId);
	options.signal?.removeEventListener("abort", onAbort);

	if (aborted) {
		return errorResult(
			toolName,
			params,
			`semble_rs execution aborted`,
			exitCode,
			stderr + stdout,
		);
	}
	if (timedOut) {
		return errorResult(
			toolName,
			params,
			`semble_rs timed out after ${timeoutMs}ms`,
			exitCode,
			stderr + stdout,
		);
	}

	// ENOENT-like spawn failure — proc exits fast with null code
	if (exitCode === null && stdout === "" && stderr === "") {
		return errorResult(
			toolName,
			params,
			`semble_rs binary not found. Build it with: cargo build --release --manifest-path agents_harness/semble_rs/Cargo.toml, or set SEMBLE_RS_BIN=/absolute/path/to/semble_rs`,
			null,
			"",
		);
	}

	return formatResult(toolName, params, stdout, stderr, exitCode);
}

function errorResult(
	toolName: string,
	params: Record<string, unknown>,
	message: string,
	exitCode: number | null,
	raw: string,
): RunSembleError {
	const { args } = buildSembleArgs(toolName, params);
	return {
		isError: true,
		text: message,
		details: { command: "semble_rs", args, exitCode, stderr: raw },
	};
}

function formatResult(
	toolName: string,
	params: Record<string, unknown>,
	stdout: string,
	stderr: string,
	exitCode: number | null,
): RunSembleResult {
	const { args } = buildSembleArgs(toolName, params);
	if (exitCode === 0) {
		let text = stdout.trim();
		if (text.length === 0) {
			text = "(semble_rs produced no stdout)";
		}
		if (stderr.trim().length > 0) {
			text = `stderr:\n${stderr}${text}`;
		}
		return {
			isError: false,
			text,
			details: { command: "semble_rs", args, exitCode: 0, stderr },
		};
	}

	let errText = `semble_rs exited with code ${exitCode}`;
	if (stderr.trim().length > 0) {
		errText += `\nstderr:\n${stderr}`;
	}
	if (stdout.trim().length > 0) {
		errText += `\nstdout:\n${stdout}`;
	}
	return {
		isError: true,
		text: errText,
		details: { command: "semble_rs", args, exitCode, stderr },
	};
}

// ---------------------------------------------------------------------------
// Re-export testable internals
// (used by co-located index.test.ts)
// ---------------------------------------------------------------------------

export function resolveSembleBinaryForTest(
	env?: Record<string, string | undefined>,
): ResolveBinaryResult {
	return resolveSembleBinary(env as typeof process.env);
}

export function resolveModelPathForTest(
	paramsModelPath?: string,
	env?: Record<string, string | undefined>,
): ResolveModelResult {
	return resolveModelPath(
		paramsModelPath,
		env as typeof process.env,
	);
}

export function buildSembleArgsForTest(
	toolName: string,
	params: Record<string, unknown>,
	modelPath?: string,
): BuildArgsResult {
	return buildSembleArgs(toolName, params, modelPath);
}

// ---------------------------------------------------------------------------
// Validate exactly-one constraint
// ---------------------------------------------------------------------------

function exactlyOne(map: Record<string, unknown | undefined>): string | null {
	const present = Object.keys(map).filter((k) => map[k] !== undefined);
	if (present.length !== 1) {
		return `Exactly one of ${Object.keys(map).join(", ")} must be provided; got ${present.length === 0 ? "none" : present.join(", ")}.`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const factory: CustomToolFactory = (pi) => {
	const tools = [
		// ── semble_digest ──────────────────────────────────────────
		{
			name: "semble_digest",
			label: "semble digest",
			description:
				"Strip noise from build/test/CI output. TRUST the tool output directly — it already filters compilation noise and keeps only errors and warnings. Do not re-summarize; use the raw tool result as-is.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					input: pi.zod
						.string()
						.optional()
						.describe(
							"Raw build/test/CI output to digest",
						),
					file: pi.zod
						.string()
						.optional()
						.describe(
							"Input file path; mutually exclusive with input",
						),
					format: pi.zod
						.enum([
							"auto",
							"cargo",
							"pnpm",
							"npm",
							"yarn",
							"node",
							"bun",
							"tsc",
							"typescript",
							"pytest",
							"python",
							"ci",
							"gha",
							"github-actions",
							"actions",
							"go",
							"gotest",
							"go-test",
							"gradle",
							"ruff",
							"mypy",
							"compiler",
							"clang",
							"gcc",
							"cmake",
							"make",
							"swift",
							"swiftc",
						])
						.default("auto"),
					show_format: pi.zod.boolean().default(false),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const p = params as {
					input?: string;
					file?: string;
				};
				const validationError = exactlyOne({
					input: p.input,
					file: p.file,
				});
				if (validationError) {
					return {
						isError: true,
						content: [{ type: "text", text: validationError }],
						details: { error: validationError },
					};
				}
				const result = await runSemble(
					"digest",
					params,
					undefined,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_search ──────────────────────────────────────────
		{
			name: "semble_search",
			label: "semble search",
			description:
				"Find code relevant to a topic using semantic embeddings. Use when grepping would miss the right files because different variable names or phrasings are used — this searches by meaning, not text.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					query: pi.zod.string().min(1),
					path: pi.zod.string().default("."),
					top_k: pi.zod
						.number()
						.int()
						.min(1)
						.max(50)
						.default(10),
					mode: pi.zod
						.enum([
							"outline",
							"compact",
							"group",
							"json",
							"json_strip",
							"full",
						])
						.default("outline"),
					include_text_files: pi.zod.boolean().default(false),
					model_path: pi.zod.string().optional(),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const p = params as { model_path?: string };
				const modelResult = resolveModelPath(p.model_path);
				if (!modelResult.ok) {
					return {
						isError: true,
						content: [
							{ type: "text", text: modelResult.message },
						],
						details: { error: modelResult.message },
					};
				}
				const result = await runSemble(
					"search",
					params,
					modelResult.path,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_deps ────────────────────────────────────────────
		{
			name: "semble_deps",
			label: "semble deps",
			description:
				"List every file this file imports and every symbol it exports. Use BEFORE editing a file to understand its dependency graph — avoids missing imports, circular deps, or breaking downstream consumers.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					file_path: pi.zod.string().min(1),
					path: pi.zod.string().default("."),
					mode: pi.zod
						.enum(["text", "json", "dot", "tree"])
						.default("text"),
					max_depth: pi.zod
						.number()
						.int()
						.min(1)
						.max(20)
						.optional(),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const result = await runSemble(
					"deps",
					params,
					undefined,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_impact ──────────────────────────────────────────
		{
			name: "semble_impact",
			label: "semble impact",
			description:
				"Find all files that import this file. Use BEFORE renaming, deleting, or changing a public API to assess blast radius. Answers 'what would break if I change this?'",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					file_path: pi.zod.string().min(1),
					path: pi.zod.string().default("."),
					mode: pi.zod
						.enum(["text", "json", "dot", "tree"])
						.default("text"),
					max_depth: pi.zod
						.number()
						.int()
						.min(1)
						.max(20)
						.optional(),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const result = await runSemble(
					"impact",
					params,
					undefined,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_tree ────────────────────────────────────────────
		{
			name: "semble_tree",
			label: "semble tree",
			description:
				"Show the directory tree of a codebase (respects .gitignore, compact). Use instead of `glob` when you need to see project structure without token explosion from recursive file listings.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					path: pi.zod.string().default("."),
					dirs_only: pi.zod.boolean().default(false),
					max_depth: pi.zod
						.number()
						.int()
						.min(1)
						.max(20)
						.optional(),
					symbols: pi.zod.boolean().default(false),
					lang: pi.zod
						.array(pi.zod.string().min(1))
						.optional(),
					include_text_files: pi.zod.boolean().default(false),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const result = await runSemble(
					"tree",
					params,
					undefined,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},


		// ── semble_find_related ────────────────────────────────────
		{
			name: "semble_find_related",
			label: "semble find-related",
			description:
				"Find code snippets semantically similar to a specific file:line location. Use when you found a pattern you want to propagate, or when debugging to find code that handles similar concerns elsewhere in the codebase.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					file_path: pi.zod.string().min(1),
					line: pi.zod.number().int().min(1),
					path: pi.zod.string().default("."),
					top_k: pi.zod
						.number()
						.int()
						.min(1)
						.max(50)
						.default(10),
					include_text_files: pi.zod.boolean().default(false),
					json: pi.zod.boolean().default(false),
					model_path: pi.zod.string().optional(),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const p = params as { model_path?: string };
				const modelResult = resolveModelPath(p.model_path);
				if (!modelResult.ok) {
					return {
						isError: true,
						content: [
							{ type: "text", text: modelResult.message },
						],
						details: { error: modelResult.message },
					};
				}
				const result = await runSemble(
					"find-related",
					params,
					modelResult.path,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_find_pattern ────────────────────────────────────
		{
			name: "semble_find_pattern",
			label: "semble find-pattern",
			description:
				"Fast AST pattern matching with compact output. PREFER THIS over the built-in ast_grep for quick structural searches — finding function definitions, class declarations, or call sites. Returns concise text results without verbose rendering.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					pattern: pi.zod.string().min(1),
					path: pi.zod.string().default("."),
					lang: pi.zod.string().optional(),
					compact: pi.zod.boolean().default(true),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const result = await runSemble(
					"find-pattern",
					params,
					undefined,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},

		// ── semble_encode ──────────────────────────────────────────
		{
			name: "semble_encode",
			label: "semble encode",
			description:
				"Encode text to a Model2Vec embedding vector (JSON). Use for debugging model behavior or comparing semantic similarity between short pieces of text.",
			strict: true,
			approval: "read" as const,
			parameters: pi.zod
				.object({
					text: pi.zod.string().optional(),
					file: pi.zod.string().optional(),
					lines: pi.zod
						.array(pi.zod.string())
						.optional(),
					model_path: pi.zod.string().optional(),
				})
				.strict(),

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				_onUpdate: unknown,
				_ctx: unknown,
				signal?: AbortSignal,
			) {
				const p = params as {
					text?: string;
					file?: string;
					lines?: string[];
					model_path?: string;
				};
				const validationError = exactlyOne({
					text: p.text,
					file: p.file,
					lines: p.lines,
				});
				if (validationError) {
					return {
						isError: true,
						content: [{ type: "text", text: validationError }],
						details: { error: validationError },
					};
				}
				if (p.lines !== undefined && p.lines.length === 0) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "lines must contain at least one non-empty item",
							},
						],
						details: {
							error: "lines must contain at least one non-empty item",
						},
					};
				}
				const modelResult = resolveModelPath(p.model_path);
				if (!modelResult.ok) {
					return {
						isError: true,
						content: [
							{ type: "text", text: modelResult.message },
						],
						details: { error: modelResult.message },
					};
				}
				const result = await runSemble(
					"encode",
					params,
					modelResult.path,
					{ cwd: pi.cwd, signal },
				);
				return wrapResult(result);
			},
		},
	];

	return tools;
};

// ---------------------------------------------------------------------------
// Convert internal RunSembleResult to AgentToolResult shape
// ---------------------------------------------------------------------------

function wrapResult(result: RunSembleResult) {
	return {
		isError: result.isError || undefined,
		content: [{ type: "text" as const, text: result.text }],
		details: result.details,
	};
}

export default factory;
