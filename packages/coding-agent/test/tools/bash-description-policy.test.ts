import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

/**
 * The rendered bash description must match what checkBashInterception actually
 * does: dedicated-tool nudges fire only when the command IS that command (they
 * never scan a compound line — see `scope` in tools/bash-interceptor.ts), while
 * refusal rules (`tool: "bash"`, e.g. build discipline) block the whole line on
 * any matching segment. Teaching "any matching segment blocks the whole
 * compound command" re-introduces the split/retry burden the 2026-10-26 policy
 * removed.
 */
function bashDescription(): string {
	const session = {
		cwd: process.cwd(),
		settings: Settings.isolated({ "bash.enabled": true }),
		isToolActive: () => true,
		getToolContext: () => ({ toolNames: ["bash", "read", "grep", "glob"], hasUI: true }),
	} as unknown as ToolSession;
	return new BashTool(session).description;
}

describe("bash description / interceptor policy", () => {
	it("distinguishes nudges from refusal rules", () => {
		const text = bashDescription();
		expect(text).toContain("Nudges do not fire inside a compound line");
		expect(text).toContain("refusal rules");
	});

	it("does not promise that every matching segment blocks the whole line", () => {
		expect(bashDescription()).not.toContain("Any matching segment blocks the WHOLE compound command");
	});
});
