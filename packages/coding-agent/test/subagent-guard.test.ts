import { describe, expect, it } from "bun:test";
import { guardSubagentHostDecisionText } from "../src/task/subagent-guard";

const NOTICE_MARKER = "NOT a real user answer or verified host state";

describe("guardSubagentHostDecisionText", () => {
	it("annotates English user-approval claims", () => {
		const out = guardSubagentHostDecisionText("Done. The user approved deleting src/legacy, so I removed it.");
		expect(out).toContain(NOTICE_MARKER);
		expect(out).toContain("user approved");
	});

	it("annotates approved-by forms", () => {
		const out = guardSubagentHostDecisionText("The deletion was approved by the user; continuing with the push.");
		expect(out).toContain(NOTICE_MARKER);
	});

	it("annotates host/human confirmation", () => {
		expect(guardSubagentHostDecisionText("host has confirmed the rollout")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("human authorized the flash")).toContain(NOTICE_MARKER);
	});

	it("annotates approval-granted phrasing", () => {
		expect(guardSubagentHostDecisionText("approval was granted for the merge")).toContain(NOTICE_MARKER);
	});

	it("annotates approval requests (waiting/awaiting)", () => {
		expect(guardSubagentHostDecisionText("The rollout is waiting for approval before continuing.")).toContain(
			NOTICE_MARKER,
		);
		expect(guardSubagentHostDecisionText("I am awaiting approval to flash the firmware.")).toContain(NOTICE_MARKER);
	});

	it("annotates ask-the-user and confirmation requests", () => {
		expect(guardSubagentHostDecisionText("I will ask the user which API to keep.")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("Please confirm before I delete the old module.")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("The merge needs user confirmation.")).toContain(NOTICE_MARKER);
	});

	it("annotates choice and input requests", () => {
		expect(guardSubagentHostDecisionText("Please choose between the two controllers.")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("The user should choose the target platform.")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("I need the user to provide the serial number.")).toContain(NOTICE_MARKER);
	});

	it("annotates Chinese approval/confirmation/choice requests", () => {
		expect(guardSubagentHostDecisionText("部署前等待用户批准。")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("请用户确认是否继续。")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("需要用户选择控制模式。")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("等待用户提供设备序列号。")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("是否批准该变更？")).toContain(NOTICE_MARKER);
	});

	it("annotates Chinese approval claims", () => {
		expect(guardSubagentHostDecisionText("任务完成，用户已批准删除旧接口。")).toContain(NOTICE_MARKER);
		expect(guardSubagentHostDecisionText("已获得授权，继续执行部署。")).toContain(NOTICE_MARKER);
	});

	it("leaves ordinary output untouched", () => {
		const plain = "Investigation complete. The bug is in src/main.cpp:42; fix is a null check.";
		expect(guardSubagentHostDecisionText(plain)).toBe(plain);
	});

	it("does not flag bare 'approved' without a subject", () => {
		const out = guardSubagentHostDecisionText("The change was approved and merged.");
		expect(out).toBe("The change was approved and merged.");
	});

	it("does not double-annotate when a guard notice is already present", () => {
		const once = guardSubagentHostDecisionText("The user approved the change.");
		const twice = guardSubagentHostDecisionText(once);
		expect(twice).toBe(once);
		expect(twice.split(NOTICE_MARKER).length - 1).toBe(1);
	});

	it("handles empty and whitespace-only output", () => {
		expect(guardSubagentHostDecisionText("")).toBe("");
		expect(guardSubagentHostDecisionText("   ")).toBe("   ");
	});
});
