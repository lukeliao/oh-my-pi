import { describe, it, expect } from "bun:test";
import {
	resolveSembleBinaryForTest,
	resolveModelPathForTest,
	buildSembleArgsForTest,
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
});
