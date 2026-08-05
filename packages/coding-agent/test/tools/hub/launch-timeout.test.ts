/**
 * Hub launch contract regressions:
 * - process ops honor a stray `timeoutMs` (messaging-style milliseconds) as a
 *   fallback for `timeout` instead of silently falling back to the 30s default;
 * - a failed start (exited before readiness / readiness timeout) appends the
 *   captured output tail so the model sees the failure reason inline.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";

afterEach(() => {
	vi.restoreAllMocks();
});

function fakeClient(handler: (op: DaemonOperation) => DaemonRpcResult | Promise<DaemonRpcResult>): DaemonBrokerClient {
	return {
		projectDir: process.cwd(),
		request: operation => Promise.resolve(handler(operation)),
		close() {},
	};
}

const SESSION = { cwd: process.cwd() } as unknown as ToolSession;

function daemonSnapshot(name: string, state: DaemonSnapshot["state"], extra: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
	return {
		name,
		id: `${name}-id`,
		state,
		createdAt: Date.now(),
		startedAt: Date.now(),
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...extra,
	};
}

describe("hub launch timeout resolution", () => {
	it("honors timeoutMs (ms) on a process wait as a fallback for timeout", async () => {
		const seen: DaemonOperation[] = [];
		const client = fakeClient(async op => {
			seen.push(op);
			return { op: "wait", daemon: daemonSnapshot("web", "running"), timedOut: false };
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "wait", name: "web", for: "exit", timeoutMs: 1_500_000 });

		expect(seen).toHaveLength(1);
		expect(seen[0].op).toBe("wait");
		expect((seen[0] as Extract<DaemonOperation, { op: "wait" }>).timeoutMs).toBe(1_500_000);
	});

	it("prefers explicit timeout (seconds) over timeoutMs", async () => {
		const seen: DaemonOperation[] = [];
		const client = fakeClient(async op => {
			seen.push(op);
			return { op: "wait", daemon: daemonSnapshot("web", "running"), timedOut: false };
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "wait", name: "web", for: "exit", timeout: 60, timeoutMs: 7_000 });

		expect((seen[0] as Extract<DaemonOperation, { op: "wait" }>).timeoutMs).toBe(60_000);
	});

	it("defaults to 30s when neither timeout nor timeoutMs is given", async () => {
		const seen: DaemonOperation[] = [];
		const client = fakeClient(async op => {
			seen.push(op);
			return { op: "wait", daemon: daemonSnapshot("web", "running"), timedOut: false };
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "wait", name: "web" });

		expect((seen[0] as Extract<DaemonOperation, { op: "wait" }>).timeoutMs).toBe(30_000);
	});

	it("treats timeoutMs=0 as absent (default 30s) — indefinite is messaging-only", async () => {
		const seen: DaemonOperation[] = [];
		const client = fakeClient(async op => {
			seen.push(op);
			return { op: "wait", daemon: daemonSnapshot("web", "running"), timedOut: false };
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "wait", name: "web", timeoutMs: 0 });

		expect((seen[0] as Extract<DaemonOperation, { op: "wait" }>).timeoutMs).toBe(30_000);
	});

	it("applies the fallback to logs and stop too", async () => {
		const seen: DaemonOperation[] = [];
		const client = fakeClient(async op => {
			seen.push(op);
			if (op.op === "logs") {
				return {
					op: "logs",
					name: "web",
					text: "out",
					cursor: 1,
					timedOut: false,
					state: "running",
				} as DaemonRpcResult;
			}
			return { op: "stop", daemon: daemonSnapshot("web", "exited", { exitCode: 0 }) };
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "logs", name: "web", timeoutMs: 45_000 });
		await executeLaunch(SESSION, { op: "stop", name: "web", timeoutMs: 45_000 });

		expect((seen[0] as Extract<DaemonOperation, { op: "logs" }>).timeoutMs).toBe(45_000);
		expect((seen[1] as Extract<DaemonOperation, { op: "stop" }>).timeoutMs).toBe(45_000);
	});
});

describe("hub start failure output tail", () => {
	const traceback = "Traceback (most recent call last):\n  File \"collect.py\", line 12, in <module>\nRuntimeError: boom";

	it("appends the captured output tail when a start exits before readiness", async () => {
		const calls: DaemonOperation[] = [];
		const client = fakeClient(op => {
			calls.push(op);
			if (op.op === "start") {
				return {
					op: "start",
					daemon: daemonSnapshot("collect_fixed", "failed", {
						exitCode: 1,
						exitReason: "exited with code 1",
						exitedAt: Date.now(),
						outputBytes: traceback.length,
					}),
					readyTimedOut: false,
				};
			}
			return {
				op: "logs",
				name: "collect_fixed",
				text: traceback,
				cursor: 5,
				timedOut: false,
				state: "failed",
			};
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(SESSION, {
			op: "start",
			name: "collect_fixed",
			application: "python3",
			args: ["-W", "ignore", "collect.py"],
			ready: { log: "consistency gate: ok" },
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("[last 25 lines of output]");
		expect(text).toContain("RuntimeError: boom");
		// Follow-up logs request: tail-sized, short timeout, no terminal replay.
		expect(calls).toHaveLength(2);
		const logsCall = calls[1] as Extract<DaemonOperation, { op: "logs" }>;
		expect(logsCall.lines).toBe(25);
		expect(logsCall.renderTerminalRows).toBe(false);
		expect(logsCall.timeoutMs).toBe(5_000);
	});

	it("appends the tail on a readiness timeout too", async () => {
		const client = fakeClient(op => {
			if (op.op === "start") {
				return {
					op: "start",
					daemon: daemonSnapshot("web", "running", { pid: 123 }),
					readyTimedOut: true,
				};
			}
			return {
				op: "logs",
				name: "web",
				text: "started, but never matched the banner",
				cursor: 9,
				timedOut: false,
				state: "running",
			};
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(SESSION, {
			op: "start",
			name: "web",
			application: "bun",
			args: ["run", "dev"],
			ready: { log: "Local:.*http", timeout: 5 },
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("NOT ready");
		expect(text).toContain("never matched the banner");
	});

	it("does not fetch logs for a successful start", async () => {
		const calls: DaemonOperation[] = [];
		const client = fakeClient(op => {
			calls.push(op);
			return {
				op: "start",
				daemon: daemonSnapshot("web", "ready", { pid: 123, readyMatch: "consistency gate: ok" }),
				readyTimedOut: false,
			};
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(SESSION, { op: "start", name: "web", application: "bun", ready: { log: "ok" } });

		expect(calls).toHaveLength(1);
		expect(calls[0].op).toBe("start");
	});

	it("keeps the failure result intact when the tail fetch fails", async () => {
		const client = fakeClient(op => {
			if (op.op === "start") {
				return {
					op: "start",
					daemon: daemonSnapshot("collect_fixed", "failed", {
						exitCode: 1,
						exitReason: "exited with code 1",
						exitedAt: Date.now(),
					}),
					readyTimedOut: false,
				};
			}
			throw new Error("broker gone");
		});
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(SESSION, {
			op: "start",
			name: "collect_fixed",
			application: "python3",
			ready: { log: "consistency gate: ok" },
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Failed to launch");
		expect(text).not.toContain("[last 25 lines of output]");
	});
});
