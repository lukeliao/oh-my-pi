/**
 * WS2 permission rules for bash execution.
 *
 * Pure, I/O-free rule evaluation layered in front of the existing bash
 * approval flow. Rules are configured under `permission.rules` and follow the
 * DeepSeek-Reasonix grammar:
 *
 *   - `Bash`              — matches any bash command.
 *   - `Bash=<literal>`    — exact whole-command match (literal characters, no
 *                            wildcards).
 *   - `Bash(<subject>)`   — exact match of a whole command or, for compound
 *                            commands, of an individual segment.
 *   - `Bash(<subject>:*)` — prefix match: a whole command or a segment that
 *                            starts with `<subject>`.
 *   - `Bash(<subject>*)`  — alias for the prefix form above.
 *
 * Compound commands (`&&`, `|`, `;`) are matched segment-by-segment: any deny
 * segment denies the whole line, otherwise any ask segment asks, otherwise the
 * line is allowed only when every segment is covered by an allow rule. Syntax
 * whose segmentation cannot be determined with the flat scanner (heredocs,
 * `$(...)`, backticks, grouping, unbalanced quotes) falls back to whole-command
 * matching. When no rule decides, the decision is `undefined` and the existing
 * approval posture is preserved unchanged.
 *
 * A dynamic bash command (`eval`, `source`, a leading `.`, or a shell invoked
 * with `-c`) is denied by default once any permission rule is active, unless an
 * exact literal allow rule (`Bash=<literal>`) matches the whole command
 * verbatim. With no rules configured the module is a complete no-op.
 */

import { extractFlatShellCommandSegments } from "../tools/shell-tokenize";

export type PermissionAction = "deny" | "ask" | "allow";

export interface PermissionRule {
	match: string;
	action: PermissionAction;
}

export interface BashRuleDecision {
	action: PermissionAction | undefined;
	matched?: PermissionRule;
}

const PERMISSION_ACTIONS: Record<string, true> = { deny: true, ask: true, allow: true };

/**
 * Normalize the raw `permission.rules` setting value into valid rules, skipping
 * entries that are malformed. Mirrors the shape of the legacy bash approval
 * pattern loader so a single source of truth owns the config contract.
 */
export function getPermissionRules(value: unknown): PermissionRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
			if (PERMISSION_ACTIONS[action] !== true) return undefined;
			const match = record.match.trim();
			if (match.length === 0) return undefined;
			return { match, action: action as PermissionAction };
		})
		.filter((rule): rule is PermissionRule => !!rule);
}

export type BashRuleKind = "bare" | "exact" | "prefix" | "literal";

export interface ParsedBashRule {
	kind: BashRuleKind;
	subject?: string;
}

/**
 * Parse a single `match` string into its structural form. Unsupported or
 * malformed forms return `undefined` so the rule is ignored rather than
 * crashing evaluation.
 */
export function parseBashRule(match: string): ParsedBashRule | undefined {
	if (typeof match !== "string") return undefined;
	const trimmed = match.trim();
	if (trimmed.length === 0) return undefined;

	if (trimmed === "Bash") return { kind: "bare" };

	if (trimmed.startsWith("Bash=")) {
		return { kind: "literal", subject: trimmed.slice("Bash=".length) };
	}

	if (trimmed.startsWith("Bash(") && trimmed.endsWith(")")) {
		const inner = trimmed.slice("Bash(".length, -1);
		if (inner.length === 0) return undefined;
		if (inner.endsWith(":*")) {
			return { kind: "prefix", subject: inner.slice(0, -2) };
		}
		if (inner.endsWith("*")) {
			return { kind: "prefix", subject: inner.slice(0, -1) };
		}
		return { kind: "exact", subject: inner };
	}

	return undefined;
}

interface InternalRule extends PermissionRule {
	parsed: ParsedBashRule;
}

function parseRules(rules: PermissionRule[]): InternalRule[] {
	const out: InternalRule[] = [];
	for (const rule of rules) {
		const parsed = parseBashRule(rule.match);
		if (parsed) out.push({ ...rule, parsed });
	}
	return out;
}

function ruleMatchesText(rule: ParsedBashRule, text: string): boolean {
	if (text.length === 0) return false;
	switch (rule.kind) {
		case "bare":
			return true;
		case "literal":
		case "exact":
			return rule.subject !== undefined && text === rule.subject;
		case "prefix":
			return rule.subject !== undefined && text.startsWith(rule.subject);
	}
}

const DYNAMIC_SHELLS: Record<string, true> = {
	bash: true,
	sh: true,
	zsh: true,
	ksh: true,
	dash: true,
	fish: true,
	ash: true,
	csh: true,
	tcsh: true,
};

/** Interpreters whose -e/-c/-r flags execute their argument as code. */
const DYNAMIC_INTERPRETERS: Record<string, true> = {
	python: true,
	python3: true,
	ruby: true,
	perl: true,
	node: true,
	php: true,
};

/** Prefix wrappers that execute their argument (`command`, `sudo`, `env`, ...). */
const PREFIX_WRAPPERS: Record<string, true> = {
	command: true,
	builtin: true,
	exec: true,
	env: true,
	time: true,
	nice: true,
	nohup: true,
	sudo: true,
};

/** Leading `NAME=value` assignment prefix (e.g. `FOO=bar eval x`). */
const ASSIGNMENT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Strip backslash escapes from a word (`ev\al` → `eval`); the shell executes the unescaped form. */
function normalizeWord(word: string): string {
	let out = "";
	for (let i = 0; i < word.length; i++) {
		if (word[i] === "\\" && i + 1 < word.length) {
			out += word[i + 1];
			i++;
		} else {
			out += word[i];
		}
	}
	return out;
}

/**
 * Conservative lexical check for a dynamic bash command: one whose first
 * command word is `eval`, `source`, or a leading `.` (optionally via the
 * `command` builtin, with backslash escapes normalized), that invokes a shell
 * with any `-c` flag variant (`-c`, `-lc`, `-ic`, or a `-c` anywhere among
 * flags), or that invokes a known interpreter (`python`, `ruby`, `perl`,
 * `node`, `php`) with a code-executing flag. Deliberately not a full parser —
 * it scans flat segments and falls back to the whole command when
 * segmentation is unavailable, and it remains an over-approximation: exotic
 * wrappers (aliases, functions, `env VAR=1 bash -c ...` style prefixes) are
 * out of scope. Exact literal allow rules (`Bash=<literal>`) are the escape
 * hatch for legitimate dynamic invocations.
 *
 * Known boundaries (documented, shared with the Reasonix baseline):
 * - The flat segmenter (`extractFlatShellCommandSegments`) does not split on
 *   escaped separators (`echo x\; rm -rf /`) or redirect-combination operators
 *   (`>|`, `>&`); such lines are treated as one segment, so per-segment rules
 *   may not match parts of them. Do not rely on this gate for adversarial
 *   shell input; it is an opt-in mitigation layer on top of the existing
 *   approval posture.
 * - Prefix rules match any same-prefix suffix (`Bash(git*)` also matches
 *   `gitx ...`); use `Bash=<literal>` or `Bash(<subject>)` exact forms for
 *   precision.
 * - Activating any rule flips dynamic commands (`eval`/`source`/shell `-c`/
 *   interpreter `-c`-style) to hard deny — legitimate dynamic invocations
 *   need an exact literal allow rule (`Bash=<literal>`).
 */
export function isDynamicBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;
	const segments = extractFlatShellCommandSegments(command);
	const targets = segments.length > 0 ? segments : [trimmed];
	return targets.some(segment => {
		const words = segment
			.trim()
			.split(/\s+/u)
			.filter(word => word.length > 0);
		if (words.length === 0) return false;
		// Skip leading assignments (`FOO=bar ...`) and wrapper prefixes
		// (`command`, `sudo`, `env`, ...) — the wrapped word is what executes.
		let idx = 0;
		while (
			idx < words.length - 1 &&
			(ASSIGNMENT_PREFIX_RE.test(words[idx]) || PREFIX_WRAPPERS[normalizeWord(words[idx])] === true)
		) {
			idx++;
		}
		const first = normalizeWord(words[idx]);
		if (first === "eval" || first === "source" || first === ".") return true;
		const rest = words.slice(idx + 1).map(normalizeWord);
		if (DYNAMIC_SHELLS[first] === true && rest.some(w => w === "-c" || /^-[a-zA-Z]*c$/u.test(w))) return true;
		if (DYNAMIC_INTERPRETERS[first] === true && rest.some(w => w === "-c" || w === "-e" || w === "-r")) return true;
		return false;
	});
}

/**
 * Evaluate configured permission rules against a bash command.
 *
 * Priority is deny > ask > allow; within an action the first rule in array
 * order that applies wins. Compound commands are matched per segment. When no
 * rule decides, `action` is `undefined` so callers fall back to the existing
 * approval posture.
 */
export function evaluateBashRules(rules: PermissionRule[], command: string): BashRuleDecision {
	const parsed = parseRules(rules);
	// No configured rules -> no-op, preserving the existing approval behavior
	// (including for dynamic commands).
	if (parsed.length === 0) return { action: undefined };

	// Dynamic bash hard gate: once any permission rule is active, dynamic
	// commands default to deny unless an exact literal allow rule matches the
	// whole command verbatim.
	if (isDynamicBashCommand(command)) {
		for (const rule of parsed) {
			if (rule.action === "allow" && rule.parsed.kind === "literal" && ruleMatchesText(rule.parsed, command)) {
				return { action: "allow", matched: rule };
			}
		}
		return { action: "deny" };
	}

	const segments = extractFlatShellCommandSegments(command);
	const decomposable = segments.length > 0;

	const ruleApplies = (rule: InternalRule): boolean => {
		if (!decomposable) return ruleMatchesText(rule.parsed, command);
		if (rule.action === "allow") {
			// A literal allow vouches for the whole command; bare/exact/prefix
			// must cover every segment so an unsafe one cannot ride a narrow rule.
			if (rule.parsed.kind === "literal") return ruleMatchesText(rule.parsed, command);
			return segments.every(segment => ruleMatchesText(rule.parsed, segment));
		}
		// deny/ask fire on the whole command or any single segment.
		if (ruleMatchesText(rule.parsed, command)) return true;
		return segments.some(segment => ruleMatchesText(rule.parsed, segment));
	};

	for (const rule of parsed) {
		if (rule.action === "deny" && ruleApplies(rule)) return { action: "deny", matched: rule };
	}
	for (const rule of parsed) {
		if (rule.action === "ask" && ruleApplies(rule)) return { action: "ask", matched: rule };
	}
	for (const rule of parsed) {
		if (rule.action === "allow" && ruleApplies(rule)) return { action: "allow", matched: rule };
	}
	return { action: undefined };
}
