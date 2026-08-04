import { describe, expect, it } from "bun:test";
import {
	evaluateBashRules,
	getPermissionRules,
	isDynamicBashCommand,
	parseBashRule,
	type PermissionRule,
} from "./rules";

const rule = (match: string, action: PermissionRule["action"]): PermissionRule => ({ match, action });

describe("parseBashRule", () => {
	it("parses the bare form", () => {
		expect(parseBashRule("Bash")).toEqual({ kind: "bare" });
	});

	it("parses the literal form without wildcard interpretation", () => {
		expect(parseBashRule("Bash=go test ./...")).toEqual({ kind: "literal", subject: "go test ./..." });
	});

	it("parses exact and both prefix forms", () => {
		expect(parseBashRule("Bash(go test)")).toEqual({ kind: "exact", subject: "go test" });
		expect(parseBashRule("Bash(go test:*)")).toEqual({ kind: "prefix", subject: "go test" });
		expect(parseBashRule("Bash(go test*)")).toEqual({ kind: "prefix", subject: "go test" });
	});

	it("ignores malformed or unknown forms", () => {
		expect(parseBashRule("")).toBeUndefined();
		expect(parseBashRule("  ")).toBeUndefined();
		expect(parseBashRule("Bash()")).toBeUndefined();
		expect(parseBashRule("SomethingElse")).toBeUndefined();
		expect(parseBashRule("Bash[go test]")).toBeUndefined();
	});
});

describe("getPermissionRules", () => {
	it("returns an empty array for non-array input", () => {
		expect(getPermissionRules(undefined)).toEqual([]);
		expect(getPermissionRules("nope")).toEqual([]);
	});

	it("drops malformed entries and normalizes action casing", () => {
		expect(
			getPermissionRules([
				{ match: "Bash(rm *)", action: "Deny" },
				{ match: "", action: "allow" },
				{ match: "Bash", action: "bogus" },
				{ match: 42, action: "allow" },
				null,
			]),
		).toEqual([{ match: "Bash(rm *)", action: "deny" }]);
	});
});

describe("evaluateBashRules", () => {
	it("returns undefined when rules are empty (no-op)", () => {
		expect(evaluateBashRules([], "git status").action).toBeUndefined();
	});

	it("returns undefined when no rule applies", () => {
		const rules = [rule("Bash(go test)", "allow")];
		expect(evaluateBashRules(rules, "ls -la").action).toBeUndefined();
	});

	it("matches an exact whole command", () => {
		const rules = [rule("Bash(go test ./...)", "allow")];
		expect(evaluateBashRules(rules, "go test ./...").action).toBe("allow");
	});

	it("matches a literal whole command exactly", () => {
		const rules = [rule("Bash=go test ./...", "allow")];
		expect(evaluateBashRules(rules, "go test ./...").action).toBe("allow");
		// Literal is exact: nearby commands do not match.
		expect(evaluateBashRules(rules, "go test ./... -v").action).toBeUndefined();
	});

	it("applies deny over allow for a compound line", () => {
		const rules = [rule("Bash(go test*)", "allow"), rule("Bash(rm *)", "deny")];
		expect(evaluateBashRules(rules, "go test ./... && rm -rf tmp").action).toBe("deny");
	});

	it("applies ask over allow for a compound line", () => {
		const rules = [rule("Bash(go test*)", "allow"), rule("Bash(rm *)", "ask")];
		expect(evaluateBashRules(rules, "go test ./... && rm -rf tmp").action).toBe("ask");
	});

	it("allows a compound line only when every segment is covered", () => {
		const rules = [rule("Bash(go test*)", "allow")];
		expect(evaluateBashRules(rules, "go test ./...").action).toBe("allow");
		expect(evaluateBashRules(rules, "go test ./... && go test ./other").action).toBe("allow");
	});

	it("does not let a prefix allow rule ride an unsafe segment in a compound line", () => {
		const rules = [rule("Bash(go test:*)", "allow")];
		// `rm -rf tmp` segment is not covered -> not all-allow -> undefined.
		expect(evaluateBashRules(rules, "go test ./... && rm -rf tmp").action).toBeUndefined();
	});

	it("matches deny/ask rules on any single segment", () => {
		const rules = [rule("Bash(rm -rf*)", "deny")];
		expect(evaluateBashRules(rules, "cd /tmp && rm -rf data").action).toBe("deny");
		expect(evaluateBashRules(rules, "cd /tmp; rm -rf data").action).toBe("deny");
		expect(evaluateBashRules(rules, "cd /tmp | rm -rf data").action).toBe("deny");
	});

	it("honors first-match order within the same action", () => {
		const rules = [rule("Bash(git status)", "deny"), rule("Bash(git *)", "ask")];
		const decision = evaluateBashRules(rules, "git status");
		expect(decision.action).toBe("deny");
		expect(decision.matched?.match).toBe("Bash(git status)");
	});

	it("falls back to whole-command matching for undecomposable syntax", () => {
		const rules = [rule("Bash=echo $(hostname)", "allow")];
		expect(evaluateBashRules(rules, "echo $(hostname)").action).toBe("allow");
	});

	it("pins prefix semantics: subject matches any same-prefix suffix (Reasonix-same)", () => {
		// `Bash(git*)` also matches `gitx ...` — documented over-match, shared
		// with Reasonix; use Bash= literal or Bash(subject) exact for precision.
		const allowRules = [rule("Bash(git*)", "allow")];
		expect(evaluateBashRules(allowRules, "gitx status").action).toBe("allow");
		const denyRules = [rule("Bash(cargo build*)", "deny")];
		expect(evaluateBashRules(denyRules, "cargo buildx --version").action).toBe("deny");
	});

	it("reports the matched rule on a deny decision", () => {
		const rules = [rule("Bash(rm *)", "deny")];
		const decision = evaluateBashRules(rules, "rm -rf /tmp/x");
		expect(decision.action).toBe("deny");
		expect(decision.matched?.match).toBe("Bash(rm *)");
	});
});

describe("dynamic bash hard gate", () => {
	it("denies eval/source/leading dot when any rule is active", () => {
		// An unrelated allow rule activates the permission gate; dynamic
		// commands then default to deny.
		const rules = [rule("Bash(git status)", "allow")];
		for (const command of ['eval "x"', "source ~/.bashrc", ". ./setup.sh"]) {
			expect(isDynamicBashCommand(command)).toBe(true);
			expect(evaluateBashRules(rules, command).action).toBe("deny");
		}
	});

	it("denies a shell invoked with -c when any rule is active", () => {
		const rules = [rule("Bash(git status)", "allow")];
		for (const command of ['bash -c "y"', 'sh -c "z"', 'zsh -c "w"']) {
			expect(isDynamicBashCommand(command)).toBe(true);
			expect(evaluateBashRules(rules, command).action).toBe("deny");
		}
	});

	it("is not dynamic for ordinary commands", () => {
		expect(isDynamicBashCommand("git status")).toBe(false);
		expect(isDynamicBashCommand("")).toBe(false);
		expect(isDynamicBashCommand("go test ./... && rm -rf tmp")).toBe(false);
		expect(isDynamicBashCommand("command -v git")).toBe(false);
		expect(isDynamicBashCommand("python3 script.py")).toBe(false);
		expect(isDynamicBashCommand("node app.js")).toBe(false);
	});

	it("catches dictionary escapes: command builtin, backslash, flag combos, interpreters", () => {
		// `command eval` — the command builtin executes its argument.
		expect(isDynamicBashCommand('command eval "x"')).toBe(true);
		// Backslash-escaped word — the shell executes `eval`.
		expect(isDynamicBashCommand("ev\\al 'x'")).toBe(true);
		// Combined/flagged shell -c variants.
		expect(isDynamicBashCommand('bash -lc "x"')).toBe(true);
		expect(isDynamicBashCommand("bash --noprofile -c 'x'")).toBe(true);
		expect(isDynamicBashCommand('sh -ic "x"')).toBe(true);
		// Code-executing interpreters.
		expect(isDynamicBashCommand("python3 -c 'print(1)'")).toBe(true);
		expect(isDynamicBashCommand("ruby -e 'puts 1'")).toBe(true);
		expect(isDynamicBashCommand("node -e 'console.log(1)'")).toBe(true);
		expect(isDynamicBashCommand("perl -e 'print 1'")).toBe(true);
		expect(isDynamicBashCommand("php -r 'echo 1;'")).toBe(true);
	});

	it("catches wrapper and assignment prefixes around dynamic commands", () => {
		expect(isDynamicBashCommand('sudo bash -c "x"')).toBe(true);
		expect(isDynamicBashCommand("FOO=bar eval 'x'")).toBe(true);
		expect(isDynamicBashCommand("VAR=1 python3 -c 'print(1)'")).toBe(true);
		expect(isDynamicBashCommand('env bash -c "x"')).toBe(true);
		expect(isDynamicBashCommand('nohup sh -c "x"')).toBe(true);
		// Ordinary wrapped commands stay non-dynamic.
		expect(isDynamicBashCommand("sudo git status")).toBe(false);
		expect(isDynamicBashCommand("FOO=bar cat file")).toBe(false);
		expect(isDynamicBashCommand("command -v git")).toBe(false);
	});

	it("denies the escape variants once any rule is active", () => {
		const rules = [rule("Bash(git status)", "allow")];
		for (const command of ['command eval "x"', 'bash -lc "x"', "python3 -c 'print(1)'"]) {
			expect(evaluateBashRules(rules, command).action).toBe("deny");
		}
	});

	it("escapes the hard gate with an exact literal allow rule", () => {
		const rules = [rule('Bash=bash -c "y"', "allow")];
		expect(evaluateBashRules(rules, 'bash -c "y"').action).toBe("allow");
	});

	it("does not let a prefix or exact rule escape the hard gate", () => {
		const prefix = [rule("Bash(bash -c*)", "allow")];
		expect(evaluateBashRules(prefix, 'bash -c "y"').action).toBe("deny");
		const exact = [rule("Bash(eval x)", "allow")];
		expect(evaluateBashRules(exact, "eval x").action).toBe("deny");
	});
});

describe("backward compatibility", () => {
	it("is a complete no-op with no rules configured, even for dynamic commands", () => {
		expect(evaluateBashRules([], "git status").action).toBeUndefined();
		expect(evaluateBashRules([], 'bash -c "y"').action).toBeUndefined();
		expect(evaluateBashRules([], 'eval "x"').action).toBeUndefined();
	});
});
