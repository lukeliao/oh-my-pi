import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { checkForbidReadBash } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { checkPathForbidden, forbidReadError, isPathForbidden, parseForbidList, resolveDenyList } from "./forbid-read";

const HOME = "/home/forbid-tester";

describe("parseForbidList", () => {
	const collect = (): { warnings: string[]; fn: (w: string) => void } => {
		const list: string[] = [];
		return { warnings: list, fn: w => list.push(w) };
	};

	it(`expands \${VAR} references`, () => {
		const { fn } = collect();
		const out = parseForbidList([`\${MYHOME}/.ssh`], { home: HOME, env: { MYHOME: "/home/real" }, onWarning: fn });
		expect(out).toEqual(["/home/real/.ssh"]);
	});

	it(`expands \${VAR:-default} with a fallback when the var is unset`, () => {
		const { fn } = collect();
		const out = parseForbidList([`\${MISSING:-/tmp/def}/secrets`], {
			home: HOME,
			env: {},
			onWarning: fn,
		});
		expect(out).toEqual(["/tmp/def/secrets"]);
	});

	it("skips an unset var without a default and warns", () => {
		const { warnings, fn } = collect();
		const out = parseForbidList([`\${MISSING}/x`], { home: HOME, env: {}, onWarning: fn });
		expect(out).toEqual([]);
		expect(warnings.length).toBe(1);
	});

	it("expands ~ to the home directory", () => {
		const { fn } = collect();
		expect(parseForbidList(["~/.ssh"], { home: HOME, onWarning: fn })).toEqual(["/home/forbid-tester/.ssh"]);
		expect(parseForbidList(["~"], { home: HOME, onWarning: fn })).toEqual(["/home/forbid-tester"]);
	});

	it("rejects relative paths and warns", () => {
		const { warnings, fn } = collect();
		const out = parseForbidList(["relative/path", "/ok/abs"], { home: HOME, onWarning: fn });
		expect(out).toEqual(["/ok/abs"]);
		expect(warnings.length).toBe(1);
	});

	it("returns an empty list for no entries", () => {
		expect(parseForbidList([], { home: HOME })).toEqual([]);
		expect(parseForbidList(undefined, { home: HOME })).toEqual([]);
	});
});

describe("isPathForbidden prefix matching", () => {
	const denyList = ["/home/liao/.ssh"];

	it("matches the entry itself and files beneath it", () => {
		expect(isPathForbidden("/home/liao/.ssh", denyList)).toBe(true);
		expect(isPathForbidden("/home/liao/.ssh/id_rsa", denyList)).toBe(true);
		expect(isPathForbidden("/home/liao/.ssh/config", denyList)).toBe(true);
	});

	it("does not match a sibling with a shared prefix", () => {
		expect(isPathForbidden("/home/liao/.ssh2/id_rsa", denyList)).toBe(false);
		expect(isPathForbidden("/home/liao/.ssh-notes/readme", denyList)).toBe(false);
	});

	it("does not match an unrelated path", () => {
		expect(isPathForbidden("/home/liao/.env", denyList)).toBe(false);
	});

	it("collapses .. escape before matching", () => {
		expect(isPathForbidden("/home/liao/.ssh/../.ssh/id_rsa", denyList)).toBe(true);
	});

	it("empty deny list never forbids", () => {
		expect(isPathForbidden("/home/liao/.ssh/id_rsa", [])).toBe(false);
	});
});

describe("checkPathForbidden no-op default", () => {
	it("returns undefined for an empty deny list", async () => {
		expect(await checkPathForbidden([], "/home/liao/.ssh/id_rsa")).toBeUndefined();
		expect(await checkPathForbidden(undefined, "/home/liao/.ssh/id_rsa")).toBeUndefined();
	});

	it("returns an error string when the path is denied", async () => {
		const err = await checkPathForbidden([`\${HOME}/.ssh`], "/home/forbid-tester/.ssh/id_rsa", {
			home: HOME,
			env: { HOME },
		});
		expect(err).toContain("Blocked:");
		expect(err).toContain("sandbox.forbidRead");
	});

	it("forbidReadError is model-visible", () => {
		expect(forbidReadError("/x")).toContain("Blocked:");
	});
});

describe("symlink escape is defeated", () => {
	let root: string;
	let denyDir: string;
	let linkDir: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-forbid-read-"));
		denyDir = path.join(root, "deny");
		linkDir = path.join(root, "link");
		fs.mkdirSync(denyDir);
		fs.writeFileSync(path.join(denyDir, "secret.txt"), "top secret");
		fs.symlinkSync(denyDir, linkDir, "dir");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("treats a symlink into a denied dir as forbidden", async () => {
		// isPathForbidden canonicalizes the target, so the link resolves to the denied dir.
		expect(isPathForbidden(path.join(linkDir, "secret.txt"), [denyDir])).toBe(true);
		// The end-to-end helper (used by the tool seams) agrees.
		expect(await checkPathForbidden([denyDir], path.join(linkDir, "secret.txt"))).toContain("Blocked:");
	});

	it("does not forbid a sibling dir sharing a prefix", () => {
		const sibling = path.join(root, "link2");
		expect(isPathForbidden(sibling, [denyDir])).toBe(false);
	});

	it("resolveDenyList canonicalizes the deny entry itself", () => {
		const resolved = resolveDenyList([denyDir]);
		expect(resolved).toEqual([fs.realpathSync(denyDir)]);
	});
});

describe("glob seam intercepts a denied search", () => {
	let root: string;
	let denyDir: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-forbid-glob-"));
		denyDir = path.join(root, "deny");
		fs.mkdirSync(denyDir);
		fs.writeFileSync(path.join(denyDir, "a.ts"), "export const a = 1;\n");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function createGlobTool(): GlobTool {
		const session = {
			cwd: root,
			settings: {
				get(key: string) {
					if (key === "sandbox.forbidRead") return [denyDir];
					return undefined;
				},
			},
		} as unknown as ToolSession;
		return new GlobTool(session);
	}

	it("blocks a glob rooted under the denied directory", async () => {
		const tool = createGlobTool();
		await expect(
			tool.execute("id", { path: `${denyDir}/**/*` }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow("Blocked:");
	});

	it("still allows globbing a non-denied directory", async () => {
		const tool = createGlobTool();
		const allowed = path.join(root, "allowed");
		fs.mkdirSync(allowed);
		fs.writeFileSync(path.join(allowed, "b.ts"), "export const b = 2;\n");
		await expect(
			tool.execute("id", { path: `${allowed}/**/*` }, undefined, undefined, {} as AgentToolContext),
		).resolves.toBeDefined();
	});
});

describe("bash conservative subset (checkForbidReadBash)", () => {
	let root: string;
	let denyDir: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-forbid-bash-"));
		denyDir = path.join(root, "deny");
		fs.mkdirSync(denyDir);
		fs.writeFileSync(path.join(denyDir, "secret.txt"), "top secret");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("blocks a literal read path under a denied directory", async () => {
		const result = await checkForbidReadBash(`cat ${denyDir}/secret.txt`, [denyDir]);
		expect(result.block).toBe(true);
		expect(result.message).toContain("Blocked:");
	});

	it("no-ops with an empty deny list", async () => {
		expect((await checkForbidReadBash(`cat ${denyDir}/secret.txt`, [])).block).toBe(false);
		expect((await checkForbidReadBash(`cat ${denyDir}/secret.txt`, undefined)).block).toBe(false);
	});

	it("skips tokens needing shell evaluation (conservative, does not block)", async () => {
		expect((await checkForbidReadBash("cat $HOME/secret", [denyDir])).block).toBe(false);
		expect((await checkForbidReadBash(`cat "${denyDir}/secret.txt"`, [denyDir])).block).toBe(false);
		expect((await checkForbidReadBash(`cat ${denyDir}/*.txt`, [denyDir])).block).toBe(false);
	});

	it("does not block non-read commands or non-denied paths", async () => {
		expect((await checkForbidReadBash("ls -la", [denyDir])).block).toBe(false);
		const outside = path.join(root, "outside.txt");
		fs.writeFileSync(outside, "fine");
		expect((await checkForbidReadBash(`cat ${outside}`, [denyDir])).block).toBe(false);
	});
});

describe("grep and ast_grep seams intercept a denied search", () => {
	let root: string;
	let denyDir: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-forbid-search-"));
		denyDir = path.join(root, "deny");
		fs.mkdirSync(denyDir);
		fs.writeFileSync(path.join(denyDir, "a.ts"), "export const secret = 1;\n");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function createSession(): ToolSession {
		return {
			cwd: root,
			settings: {
				get(key: string) {
					if (key === "sandbox.forbidRead") return [denyDir];
					return undefined;
				},
			},
		} as unknown as ToolSession;
	}

	it("grep blocks a search under the denied directory", async () => {
		const tool = new GrepTool(createSession());
		await expect(
			tool.execute("id", { pattern: "secret", path: denyDir }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow("Blocked:");
	});

	it("ast_grep blocks a search under the denied directory", async () => {
		const tool = new AstGrepTool(createSession());
		await expect(
			tool.execute("id", { pat: "const $_ = $VAL", path: denyDir }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow("Blocked:");
	});
});

describe("read seam intercepts a denied file", () => {
	let root: string;
	let denyDir: string;
	let secretFile: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-forbid-read-tool-"));
		denyDir = path.join(root, "deny");
		fs.mkdirSync(denyDir);
		secretFile = path.join(denyDir, "secret.txt");
		fs.writeFileSync(secretFile, "top secret\n");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function createReadSession(): ToolSession {
		return {
			cwd: root,
			settings: {
				get(key: string) {
					if (key === "sandbox.forbidRead") return [denyDir];
					return undefined;
				},
			},
			isToolActive: () => false,
		} as unknown as ToolSession;
	}

	it("blocks reading a file under the denied directory", async () => {
		const tool = new ReadTool(createReadSession());
		await expect(
			tool.execute("id", { path: secretFile }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow("Blocked:");
	});

	it("fails closed on a nonexistent path under a denied directory", async () => {
		// Regression: the gate must fire before path I/O — a denied target that
		// does not exist must yield "Blocked:", not "Path ... not found", so the
		// deny list cannot be probed for existence.
		const tool = new ReadTool(createReadSession());
		await expect(
			tool.execute(
				"id",
				{ path: path.join(denyDir, "does-not-exist.txt") },
				undefined,
				undefined,
				{} as AgentToolContext,
			),
		).rejects.toThrow("Blocked:");
	});

	it("blocks a local:// read of a denied file", async () => {
		// GATE-02 regression: local:// resolves to real on-disk paths under the
		// session artifacts root and must not bypass the deny list.
		const localRoot = path.join(root, "local");
		const deniedLocalDir = path.join(localRoot, "deny");
		fs.mkdirSync(deniedLocalDir, { recursive: true });
		const deniedLocalFile = path.join(deniedLocalDir, "secret.txt");
		fs.writeFileSync(deniedLocalFile, "top secret\n");
		const tool = new ReadTool({
			cwd: root,
			settings: {
				get(key: string) {
					if (key === "sandbox.forbidRead") return [deniedLocalDir];
					return undefined;
				},
			},
			isToolActive: () => false,
			localProtocolOptions: { getArtifactsDir: () => root, getSessionId: () => "test" },
		} as unknown as ToolSession);
		await expect(
			tool.execute("id", { path: "local://deny/secret.txt" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow("Blocked:");
	});

	it("still reads a non-denied file", async () => {
		const tool = new ReadTool(createReadSession());
		const allowedFile = path.join(root, "ok.txt");
		fs.writeFileSync(allowedFile, "fine\n");
		await expect(
			tool.execute("id", { path: allowedFile }, undefined, undefined, {} as AgentToolContext),
		).resolves.toBeDefined();
	});
});
