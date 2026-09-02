import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type BashInterceptorRule,
	DEFAULT_BASH_INTERCEPTOR_RULES,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: {
			get(key: string) {
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		const command = "cd packages/coding-agent && cat package.json";
		await expect(
			tool.execute("tool-call", { command }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow(
			`Use read instead.\n\nDeterministic policy (bash:shadowed:read): retrying this command, or any bash variant of it, will be blocked again.\n\nOriginal command: ${command}`,
		);
	});
});

describe("compound command interception", () => {
	const rules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*git\\s+commit\\b",
			tool: "commit",
			message: "Use the commit tool instead.",
		},
	];

	it.each([
		"git commit -m message",
		"git add file && git commit -m message",
		"git add file; git commit -m message",
		"git add file || git commit -m message",
		"git add file & git commit -m message",
		"git add file\ngit commit -m message",
	])("blocks a later command after %s", command => {
		expect(checkBashInterception(command, ["commit"], rules).block).toBe(true);
	});

	it("does not intercept a downstream pipe stage that consumes piped stdin", () => {
		// `git commit` after a single `|` reads the previous stage's stdout, so
		// the dedicated tool cannot replace it. `||` still starts a fresh command.
		expect(checkBashInterception("git add file | git commit -m message", ["commit"], rules).block).toBe(false);
		expect(checkBashInterception("git add file || git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("removes one or more leading environment assignments before matching", () => {
		expect(
			checkBashInterception('GIT_AUTHOR_EMAIL="a@example.com" git commit -m message', ["commit"], rules).block,
		).toBe(true);
		expect(
			checkBashInterception(
				'GIT_AUTHOR_EMAIL="a@example.com" GIT_AUTHOR_NAME=Dev git commit -m message',
				["commit"],
				rules,
			).block,
		).toBe(true);
	});

	it("does not treat quoted, escaped, or commented text as a later command", () => {
		for (const command of [
			"printf '%s\\n' \"git add file && git commit -m message\"",
			'echo "git commit"',
			"echo git\\ commit",
			"echo ok # git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("does not treat redirection targets as later commands", () => {
		for (const command of [
			"echo hi >|git commit -m message",
			"echo hi >| git commit -m message",
			"echo hi >&git commit -m message",
			"echo hi >& git commit -m message",
			"echo hi <&3 git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
		// <& is a redirect operator, so the & does not split the command;
		// but when a && follows the redirect, the later command is still extracted.
		expect(checkBashInterception("echo hi <&3 && git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("does not add matches for unsupported shell syntax", () => {
		for (const command of [
			'echo "$(git commit -m message)"',
			"echo `git commit -m message`",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell parameter expansion under test
			"echo ${x:-foo;git commit -m message}",
			"( git commit -m message )",
			"echo start; { true; git commit -m message; }",
			"cat <<'EOF'\ngit commit -m message\nEOF",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("keeps matching a rule written for the complete original input", () => {
		const command = "git add file && git commit -m message";
		const completeInputRule: BashInterceptorRule[] = [
			{
				pattern: "^git add file && git commit",
				tool: "commit",
				message: "Use the commit tool instead.",
			},
		];
		expect(checkBashInterception(command, ["commit"], completeInputRule).block).toBe(true);
	});

	it("does not block when the suggested tool is unavailable", () => {
		expect(checkBashInterception("git add file && git commit -m message", [], rules).block).toBe(false);
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("default grep rule and pipeline stdin", () => {
	const tools = ["grep"];

	it("blocks standalone file searches", () => {
		expect(checkBashInterception("grep pattern path", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("rg pattern src", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks a first-stage grep that produces pipeline input", () => {
		expect(checkBashInterception("grep x file | wc -l", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block grep consuming pipeline stdin", () => {
		expect(checkBashInterception("printf 'x\\n' | grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(
			checkBashInterception("tr -d '\\r' < input.log | grep -v '^ *foo'", tools, DEFAULT_BASH_INTERCEPTOR_RULES)
				.block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(
			checkBashInterception("printf 'x\\n' |\n # filter\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |& grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks a standalone grep sequenced after a pipeline", () => {
		expect(
			checkBashInterception("cat log | tr a b && grep err file", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});
});

describe("default hub start rules", () => {
	const tools = ["hub"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to hub start",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("hub");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});

describe("build-discipline interception (project rules)", () => {
	const buildRules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*(cargo\\s+(build|test|clippy|check)|rustc|maturin)\\s",
			tool: "bash",
			message: "禁止裸 cargo/rustc 绕过 build system",
		},
		{
			pattern: "^\\s*docker\\s+(run|build|buildx)\\s",
			tool: "bash",
			message: "禁止裸 docker run/build 绕过 build-products.sh",
		},
	];
	const tools = ["bash"];

	it.each([
		"cargo build --release",
		"env X=1 cargo build --release",
		"time cargo build --release",
		"sudo cargo build --release",
		"cd repo; cargo build --release",
		"cargo build --release | tee log",
		"bash -c 'cargo build --release'",
		"docker run -it ubuntu bash",
		"time docker run ubuntu",
		"sudo docker run ubuntu",
	])("blocks wrapped bare build %s", command => {
		expect(checkBashInterception(command, tools, buildRules).block).toBe(true);
	});

	it.each(["docker ps", "docker logs -f app", "docker system df", "cmake --version", "ls -la", "cargo fmt --check"])(
		"does not block read-only / non-build commands %s",
		command => {
			expect(checkBashInterception(command, tools, buildRules).block).toBe(false);
		},
	);
});

describe("default find/fd glob rule", () => {
	const tools = ["glob"];

	it.each([
		"find . -name '*.ts'",
		'find src -type f -name "*.test.ts"',
		"find . -iname foo",
		"fd --type file bar",
		"find /opt/my-size -name x",
	])("blocks pure name/type find %s", command => {
		expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it.each([
		"find . -type f -newer ref.txt",
		"find . -name '*.log' -delete",
		"find . -type d -exec chmod 755 {} +",
		"find . -size +10M -name '*.iso'",
		"find . -mtime -7 -name '*.log'",
		"find . -user www-data -name x",
		"find . -perm 644 -name x",
		"fd --changed-within 1d --type file",
	])("does not block glob-inexpressible find %s", command => {
		expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("policyKey and repeat-block escalation", () => {
	const rules: BashInterceptorRule[] = [{ pattern: "^\\s*find\\s", tool: "glob", message: "use the glob tool" }];
	const ctx = { toolNames: ["glob"] } as AgentToolContext;

	it("derives the policyKey from the suggested tool by default", () => {
		const result = checkBashInterception("find . -name x", ["glob"], rules);
		expect(result.block).toBe(true);
		expect(result.policyKey).toBe("bash:shadowed:glob");
	});

	it("uses an explicit policyKey and marks the block deterministic", () => {
		const result = checkBashInterception("find . -name x", ["glob"], [{ ...rules[0], policyKey: "project:custom" }]);
		expect(result.policyKey).toBe("project:custom");
		expect(result.message).toContain("Deterministic policy (project:custom)");
		expect(result.message).toContain("will be blocked again");
	});

	it("escalates on the second block of the same policy", async () => {
		const tool = createBashTool(rules);
		await expect(tool.execute("a", { command: "find . -name x" }, undefined, undefined, ctx)).rejects.toThrow(
			"use the glob tool",
		);
		await expect(tool.execute("b", { command: "find . -iname y" }, undefined, undefined, ctx)).rejects.toThrow(
			/Repeat block #2 for policy bash:shadowed:glob/,
		);
	});

	it("exposes structured policy details on the thrown ToolError", async () => {
		const tool = createBashTool(rules);
		try {
			await tool.execute("c", { command: "find . -name z" }, undefined, undefined, ctx);
			throw new Error("expected the interceptor to block");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			expect((error as ToolError).context).toMatchObject({
				code: "shadowed_tool",
				dedicatedTool: "glob",
				policyKey: "bash:shadowed:glob",
				retryable: false,
				repeatCount: 1,
			});
		}
	});
});

describe("extraPatterns precedence (extras before patterns)", () => {
	const extras: BashInterceptorRule[] = [
		{
			pattern: "^\\s*find\\s+\\.git\\b",
			tool: "bash",
			policyKey: "allow:find-git",
			message: "searching .git internals is allowed in this project",
		},
	];

	it("a narrow extra shadows the broad default for its case", () => {
		const result = checkBashInterception(
			"find .git/objects -name x",
			["bash", "glob"],
			[...extras, ...DEFAULT_BASH_INTERCEPTOR_RULES],
		);
		expect(result.policyKey).toBe("allow:find-git");
	});

	it("built-in defaults still apply for everything else", () => {
		const result = checkBashInterception(
			"find src -name x",
			["bash", "glob"],
			[...extras, ...DEFAULT_BASH_INTERCEPTOR_RULES],
		);
		expect(result.policyKey).toBe("bash:shadowed:glob");
	});
});

describe("getBashInterceptorRules extraPatterns merge", () => {
	it("prepends extras to patterns", () => {
		const extra: BashInterceptorRule = {
			pattern: "^\\s*sqlite3\\s",
			tool: "bash",
			policyKey: "project:db",
			message: "use the db-query script",
		};
		const settings = Settings.isolated({
			"bashInterceptor.extraPatterns": [extra],
		});
		expect(settings.getBashInterceptorRules()).toEqual([extra, ...DEFAULT_BASH_INTERCEPTOR_RULES]);
	});
});
