import { describe, it, expect } from "bun:test";
import {
	resolveSembleBinaryForTest,
	resolveModelPathForTest,
	buildSembleArgsForTest,
	resolveGraphTargetForTest,
} from "./index";

// ---------------------------------------------------------------------------
// resolveModelPath — local model policy enforcement
// ---------------------------------------------------------------------------

describe("resolveModelPath", () => {
	it("returns error when no model_path or SEMBLE_MODEL_PATH is set", () => {
		const result = resolveModelPathForTest(undefined, {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain(
				"SEMBLE_MODEL_PATH or model_path is required",
			);
		}
	});

	it("returns error when resolved path does not exist", () => {
		const result = resolveModelPathForTest("/nonexistent/model/path");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("does not exist");
		}
	});
});

// ---------------------------------------------------------------------------
// resolveSembleBinary — env variable guard
// ---------------------------------------------------------------------------

describe("resolveSembleBinary", () => {
	it("returns error for misspelled SEMLE_RS_BIN", () => {
		const result = resolveSembleBinaryForTest({
			SEMLE_RS_BIN: "/tmp/wrong",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain(
				"Unsupported SEMLE_RS_BIN is set; use SEMBLE_RS_BIN instead.",
			);
		}
	});
});

// ---------------------------------------------------------------------------
// buildSembleArgs — CLI argument construction
// ---------------------------------------------------------------------------

describe("buildSembleArgs", () => {
	it("builds search args with outline mode", () => {
		const result = buildSembleArgsForTest(
			"search",
			{
				query: "auth",
				path: ".",
				top_k: 3,
				mode: "outline",
				include_text_files: false,
			},
			"/models/potion",
		);
		expect(result.args).toEqual([
			"search",
			"auth",
			".",
			"--top-k",
			"3",
			"--model",
			"/models/potion",
			"--outline",
		]);
	});

	it("builds digest args with stdin text", () => {
		const result = buildSembleArgsForTest("digest", {
			input: "error",
			format: "auto",
			show_format: false,
		});
		expect(result.args).toEqual(["digest", "--format", "auto"]);
		expect(result.stdinText).toBe("error");
	});

	it("builds deps args with tree mode and max_depth", () => {
		const result = buildSembleArgsForTest("deps", {
			file_path: "src/main.rs",
			path: ".",
			mode: "tree",
			max_depth: 2,
		});
		expect(result.args).toEqual([
			"deps",
			"src/main.rs",
			".",
			"--tree",
			"--max-depth",
			"2",
		]);
	});

	it("builds tree args with symbols and lang filter", () => {
		const result = buildSembleArgsForTest("tree", {
			path: ".",
			dirs_only: false,
			symbols: true,
			lang: ["rust", "python"],
			include_text_files: false,
		});
		expect(result.args).toEqual([
			"tree",
			".",
			"--symbols",
			"--lang",
			"rust,python",
		]);
	});

	it("builds find_related args with json", () => {
		const result = buildSembleArgsForTest(
			"find-related",
			{
				file_path: "src/main.rs",
				line: 42,
				path: ".",
				top_k: 10,
				include_text_files: false,
				json: true,
			},
			"/models/potion",
		);
		expect(result.args).toEqual([
			"find-related",
			"src/main.rs",
			"42",
			".",
			"--top-k",
			"10",
			"--model",
			"/models/potion",
			"--json",
		]);
	});

	it("builds encode args with text string", () => {
		const result = buildSembleArgsForTest(
			"encode",
			{ text: "hello world" },
			"/models/potion",
		);
		expect(result.args).toEqual([
			"encode",
			"--model",
			"/models/potion",
			"hello world",
		]);
	});

	it("builds encode args with lines via stdin", () => {
		const result = buildSembleArgsForTest(
			"encode",
			{ lines: ["hello", "world"] },
			"/models/potion",
		);
		expect(result.args).toEqual([
			"encode",
			"--model",
			"/models/potion",
		]);
		expect(result.stdinText).toBe("hello\nworld\n");
	});

	it("builds find-pattern args with lang and compact", () => {
		const result = buildSembleArgsForTest("find-pattern", {
			pattern: "fn $name($$$)",
			path: ".",
			lang: "rust",
			compact: true,
		});
		expect(result.args).toEqual([
			"find-pattern",
			"fn $name($$$)",
			".",
			"--lang",
			"rust",
			"--compact",
		]);
	});

	it("builds impact args with tree mode", () => {
		const result = buildSembleArgsForTest("impact", {
			file_path: "src/lib.rs",
			path: ".",
			mode: "tree",
			max_depth: 5,
		});
		expect(result.args).toEqual([
			"impact",
			"src/lib.rs",
			".",
			"--tree",
			"--max-depth",
			"5",
		]);
	});

	// `semble_rs deps|impact` require <FILE_PATH> relative to <PATH>; an absolute
	// path always fails with `File not found in graph: /abs/...`. Conversion must
	// resolve the root against the SUBPROCESS cwd (pi.cwd), not process.cwd, and a
	// file outside the root is an error — narrowing the graph would hide callers.
	it("resolves an absolute deps/impact file_path against the subprocess cwd", () => {
		const result = resolveGraphTargetForTest("/repo/crates/psr/src/lib.rs", ".", "/repo");
		expect(result).toEqual({ ok: true, filePath: "crates/psr/src/lib.rs", root: "." });
	});

	it("resolves a root that is itself relative, against the subprocess cwd", () => {
		const result = resolveGraphTargetForTest(
			"/repo/a/b/c/src/main.rs",
			"a/b",
			"/repo",
		);
		expect(result).toEqual({ ok: true, filePath: "c/src/main.rs", root: "a/b" });
	});

	it("resolves against the subprocess cwd even when process.cwd() differs", () => {
		const saved = process.cwd();
		process.chdir("/tmp");
		try {
			const result = resolveGraphTargetForTest("/repo/src/main.rs", ".", "/repo");
			expect(result).toEqual({ ok: true, filePath: "src/main.rs", root: "." });
		} finally {
			process.chdir(saved);
		}
	});

	it("keeps an absolute root untouched while making the file relative", () => {
		const result = resolveGraphTargetForTest("/repo/src/main.rs", "/repo", "/elsewhere");
		expect(result).toEqual({ ok: true, filePath: "src/main.rs", root: "/repo" });
	});

	it("errors instead of shrinking the graph when the file is outside the root", () => {
		const result = resolveGraphTargetForTest("/elsewhere/pkg/lib.rs", "/repo", "/repo");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected an error");
		expect(result.message).toContain("is outside path /repo");
		expect(result.message).toContain("hides callers outside it");
	});

	it("leaves a relative file_path untouched", () => {
		const result = resolveGraphTargetForTest("crates/psr/src/lib.rs", "/repo", "/anywhere");
		expect(result).toEqual({ ok: true, filePath: "crates/psr/src/lib.rs", root: "/repo" });
	});

	it("builds savings args without and with --verbose", () => {
		expect(buildSembleArgsForTest("savings", {}).args).toEqual(["savings"]);
		expect(buildSembleArgsForTest("savings", { verbose: true }).args).toEqual([
			"savings",
			"--verbose",
		]);
	});
});
