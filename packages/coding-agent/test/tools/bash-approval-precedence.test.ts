import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

/**
 * A WS2 `permission.rules` decision must never loosen the operator's
 * `bash.patterns`: the operator deny/prompt chain is evaluated first and a
 * weaker rule (allow, or ask) cannot bypass it. These cases guard the merge of
 * upstream's grantAuthority()/rawPatterns chain with our WS2 rules.
 *
 * `bash.patterns` rules use `{ match: <glob>, approval }` (upstream 18.18) and
 * WS2 rules use `{ match: "Bash(<prefix>:*)", action }`.
 */
function makeTool(settings: Record<string, unknown>): BashTool {
	const session = {
		cwd: process.cwd(),
		settings: Settings.isolated({
			"bash.enabled": true,
			"bash.autoBackground.enabled": false,
			"async.enabled": false,
			"launch.enabled": false,
			...settings,
		}),
		isToolActive: () => true,
		getToolContext: () => ({ toolNames: ["bash", "read", "grep", "glob"], hasUI: true }),
	} as unknown as ToolSession;
	return new BashTool(session);
}

type Decision = { tier?: string; policy?: string; reason?: string };

function decisionOf(tool: BashTool, command: string): Decision {
	const decision = tool.approval({ command }) as Decision | string;
	return typeof decision === "string" ? { tier: decision } : decision;
}

const COMMAND = "mydeploy run";
const DENY_PATTERN = { match: "mydeploy *", approval: "deny" as const };
const PROMPT_PATTERN = { match: "mydeploy *", approval: "prompt" as const };
const ALLOW_RULE = { match: "Bash(mydeploy:*)", action: "allow" as const };
const ASK_RULE = { match: "Bash(mydeploy:*)", action: "ask" as const };
const DENY_RULE = { match: "Bash(mydeploy:*)", action: "deny" as const };

describe("WS2 permission.rules vs operator bash.patterns", () => {
	it("keeps an operator deny under a WS2 allow rule", () => {
		const tool = makeTool({ "permission.rules": [ALLOW_RULE], "bash.patterns": [DENY_PATTERN] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("deny");
		expect(decision.reason).toContain("Blocked by bash pattern");
	});

	it("keeps an operator deny under a WS2 ask rule", () => {
		const tool = makeTool({ "permission.rules": [ASK_RULE], "bash.patterns": [DENY_PATTERN] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("deny");
		expect(decision.reason).toContain("Blocked by bash pattern");
	});

	it("still prompts when the operator pattern requires a prompt and WS2 allows", () => {
		const tool = makeTool({ "permission.rules": [ALLOW_RULE], "bash.patterns": [PROMPT_PATTERN] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("prompt");
		expect(decision.reason).toContain("Prompt required by bash pattern");
	});

	it("lets a WS2 allow skip the prompt when no operator rule matches", () => {
		const tool = makeTool({ "permission.rules": [ALLOW_RULE] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("allow");
	});

	it("lets a WS2 deny block without any operator rule", () => {
		const tool = makeTool({ "permission.rules": [DENY_RULE] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("deny");
		expect(decision.reason).toContain("Blocked by permission rule");
	});

	it("still lets an operator allow match when no WS2 rule applies", () => {
		const tool = makeTool({ "bash.patterns": [{ match: "mydeploy *", approval: "allow" as const }] });
		const decision = decisionOf(tool, COMMAND);
		expect(decision.policy).toBe("allow");
	});
});
