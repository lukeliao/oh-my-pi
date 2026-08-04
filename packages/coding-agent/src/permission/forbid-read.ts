/**
 * sandbox.forbidRead — deny-list gate for the built-in path-reading tools.
 *
 * SCOPE (reviewed boundary, do not broaden without the plan's WS3 decision):
 *   This module only gates the *built-in path-reading tools* (read, glob,
 *   grep, ast_grep) plus a conservative bash parameter subset in
 *   bash-interceptor. It is a process-internal mitigation, NOT an OS-level
 *   hard gate. The following read surfaces are deliberately OUT of scope and
 *   are not blocked here: the eval kernel (its `read()`/`Bun.file` helpers),
 *   browser tools, MCP tools, and extension/custom tools. Real bash sandboxing
 *   (bubblewrap/Seatbelt) is a separate OS-level concern (WS4).
 *
 * It complements (does not replace) the secrets obfuscator: forbid_read
 * intercepts a read *before* it happens; the obfuscator redacts secrets
 * *after* they are read. Both are opt-in and off by default.
 *
 * Default is `[]` (empty), so behavior is a no-op unless `sandbox.forbidRead`
 * is configured.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ForbidReadOptions {
	/** Home directory used for `~` expansion (defaults to os.homedir()). */
	home?: string;
	/** Environment used for `${VAR}` / `${VAR:-default}` expansion (defaults to process.env). */
	env?: NodeJS.ProcessEnv | Record<string, string>;
	/** Receives a message for each entry that is skipped (relative path / unset var). */
	onWarning?: (message: string) => void;
}

const VAR_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand a single `sandbox.forbidRead` entry: `${VAR}` / `${VAR:-default}`
 * environment references, then `~` to $HOME. Relative paths are rejected
 * (only absolute paths are meaningful for a deny list) and skipped with a
 * warning. Empty/unresolvable entries are dropped.
 *
 * This is a pure, sync expansion step — it does NOT resolve symlinks (see
 * {@link isPathForbidden} for canonicalization).
 */
export function parseForbidList(entries: string[] | undefined, opts: ForbidReadOptions = {}): string[] {
	const home = opts.home ?? os.homedir();
	const env = opts.env ?? process.env;
	const warn = opts.onWarning ?? (() => {});
	const out: string[] = [];

	for (const raw of entries ?? []) {
		if (typeof raw !== "string") {
			warn(`forbidRead entry must be a string; skipped ${String(raw)}`);
			continue;
		}
		let value = raw.trim();
		if (value.length === 0) continue;

		// `${VAR}` / `${VAR:-default}` expansion. An unset var with no default
		// is a configuration error: the entry cannot be trusted (a dangling
		// fragment like `/x` from `${MISSING}/x` would look absolute), so skip
		// the whole entry.
		let entryFailed = false;
		value = value.replace(VAR_REF_PATTERN, (match, name: string, fallback: string | undefined) => {
			const v = env[name];
			if (v !== undefined && v !== "") return v;
			if (fallback !== undefined) return fallback;
			entryFailed = true;
			warn(`forbidRead entry '${raw}': environment variable '${name}' is unset; entry skipped`);
			return "";
		});
		if (entryFailed) continue;
		if (value.length === 0) continue;

		// `~` expansion.
		if (value === "~") {
			value = home;
		} else if (value.startsWith("~/") || value.startsWith("~\\")) {
			value = path.join(home, value.slice(2));
		}

		// Deny entries must be absolute; a relative path would silently match
		// the wrong location once resolved against cwd, so refuse it.
		if (!path.isAbsolute(value)) {
			warn(`forbidRead entry '${raw}' is not an absolute path; skipped`);
			continue;
		}

		out.push(path.normalize(value));
	}
	return out;
}

/** Canonicalize a path: resolve symlinks via realpath, falling back to a lexical absolute normalize. */
function canonicalize(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		// Non-existent target or permission error: fall back to a lexical
		// normalization, which still collapses `..` segments.
		return path.normalize(path.resolve(p));
	}
}

const denyListCache = new Map<string, string[]>();

/**
 * Expand + canonicalize a deny list once (cached by entries + home). The
 * returned entries are realpath'd so symlink tunneling cannot bypass a deny
 * entry that itself lives behind a symlink.
 */
export function resolveDenyList(entries: string[] | undefined, opts: ForbidReadOptions = {}): string[] {
	const raw = entries ?? [];
	if (raw.length === 0) return [];
	const home = opts.home ?? os.homedir();
	const key = `${JSON.stringify(raw)}\u0000${home}`;
	const cached = denyListCache.get(key);
	if (cached) return cached;
	const resolved = parseForbidList(raw, opts).map(canonicalize);
	denyListCache.set(key, resolved);
	return resolved;
}

/**
 * Returns true when `targetPath` (canonicalized) is `denyEntry` itself or
 * lies beneath one. Directory entries prefix-match everything below them;
 * the path-separator check prevents `/home/liao/.ssh2` matching the
 * `/home/liao/.ssh` deny entry.
 *
 * Both sides are canonicalized (realpath + symlink resolution), which defeats
 * `..` escape and symlink tunneling.
 */
export function isPathForbidden(targetPath: string, resolvedDenyList: string[]): boolean {
	if (!resolvedDenyList || resolvedDenyList.length === 0) return false;
	const target = canonicalize(targetPath);
	for (const entry of resolvedDenyList) {
		const canon = canonicalize(entry);
		if (target === canon) return true;
		if (target.startsWith(`${canon}${path.sep}`)) return true;
	}
	return false;
}

/** Model-visible "Blocked: ..." error text for a forbidden read. */
export function forbidReadError(targetPath: string): string {
	return `Blocked: reading '${targetPath}' is forbidden by sandbox.forbidRead. This path is protected and the read/glob/grep/search tools will not access it.`;
}

/**
 * Single-entry helper used by the tool seams. Returns the "Blocked: ..."
 * error string when the target is denied, or undefined to allow the read.
 * Cheap no-op when the deny list is empty, so the default configuration
 * changes nothing.
 */
export async function checkPathForbidden(
	entries: string[] | undefined,
	targetPath: string,
	opts: ForbidReadOptions = {},
): Promise<string | undefined> {
	const raw = entries ?? [];
	if (raw.length === 0) return undefined;
	const resolved = resolveDenyList(raw, opts);
	if (resolved.length === 0) return undefined;
	if (isPathForbidden(targetPath, resolved)) return forbidReadError(targetPath);
	return undefined;
}
