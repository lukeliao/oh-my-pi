/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";
import { extractFlatShellCommandSegments } from "./shell-tokenize";

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/** Removes leading `NAME=value` assignments without interpreting shell syntax. */
function withoutLeadingEnvironmentAssignments(command: string): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const assignmentStart = index;
		if (!/[A-Za-z_]/.test(command[index] ?? "")) break;
		let nameEnd = index + 1;
		while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? "")) nameEnd++;
		if (command[nameEnd] !== "=") {
			return foundAssignment ? command.slice(assignmentStart).trimStart() : null;
		}
		const wordEnd = skipShellWord(command, nameEnd + 1);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
		if (index === command.length) return null;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}

function interceptionCandidates(command: string): string[] {
	const candidates = [command.trim()];
	for (const segment of extractFlatShellCommandSegments(command)) {
		// A segment that consumes the previous stage's stdout via `|` reads piped
		// stdin, which no path-based dedicated tool (read/grep/glob) — nor any
		// other dedicated tool — can replace, so it is not an interception
		// candidate. Standalone and first-stage commands still match.
		if (segment.pipedStdin) continue;
		candidates.push(segment.text);
		const withoutAssignments = withoutLeadingEnvironmentAssignments(segment.text);
		if (withoutAssignments) candidates.push(withoutAssignments);
	}
	return candidates;
}

/**
 * Peel known one-shot wrapper prefixes from a command segment. Returns the
 * inner command, or the original if no wrapper matched. Quote-aware enough for
 * `bash -c 'cargo build'`; not a shell parser — the interceptor is a
 * best-effort nudge, not a hard gate (see docblock on {@link checkBashInterception}).
 */
function stripKnownWrappers(command: string): string {
	let rest = command.trim();
	let changed = true;
	while (changed) {
		changed = false;
		// env [flags] VAR=val... cmd — parse flags and VAR= pairs, then the rest is the command
		const envRe = /^env\s+((?:-[A-Za-z](?:\s+\S+)?\s+)*)((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(.*)$/;
		const envHit = envRe.exec(rest);
		if (envHit && envHit[3].trim()) {
			rest = envHit[3].trim();
			changed = true;
			continue;
		}
		// time / sudo / nohup prefixes
		const simple = /^(time|sudo|nohup)\s+/.exec(rest);
		if (simple) {
			rest = rest.slice(simple[0].length);
			changed = true;
			continue;
		}
		// bash -c '...' / sh -c '...' — unwrap single/double-quoted payload
		const shc = /^(?:bash|sh|zsh|dash)\s+-c\s+(['"])(.*)\1/.exec(rest);
		if (shc) {
			rest = shc[2];
			changed = true;
			continue;
		}
	}
	return rest;
}

/**
 * Check if a bash command should be intercepted.
 *
 * BEST-EFFORT NUDGE, NOT A HARD GATE:
 * Shell syntax is not fully parseable by regex — exotic wrappers (e.g.
 * `$(eval ...)`, arbitrary shell functions) are not covered. The interceptor
 * handles the common agent wrapper patterns (`env X=1 cmd`, `time cmd`,
 * `sudo`, `nohup`, `bash -c '...'`) via best-effort prefix peeling; anything
 * beyond that is deliberately not chased. The final acceptance requirement
 * (manifest.txt + ci-build.sh from clean tree, see AGENTS.md) is a soft rule
 * today: no tool in the harness automatically runs CI or rejects artifacts
 * without a manifest — it is the acceptance bar agents are instructed to
 * meet, not an enforced gate.
 *
 * Matching strategy:
 * 1. Whole-command match (anchored).
 * 2. Segment scan: split on `;`, `&&`, `|` and test each segment, so
 *    `cd repo; cargo build` and `cmd | tee log` are caught.
 * 3. Wrapper-stripped re-match: peel known one-shot prefixes (`env X=1`,
 *    `time`, `sudo`, `nohup`, `bash -c '...'`) and re-test the inner command.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
	originalCommand = command,
): InterceptionResult {
	const compiled = compileRules(rules);
	const candidates = interceptionCandidates(command);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		for (const candidate of candidates) {
			// A configured global or sticky regex carries state across calls.
			regex.lastIndex = 0;
			if (regex.test(candidate)) {
				return {
					block: true,
					message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
					suggestedTool: rule.tool,
				};
			}
		}

		// Wrapper-stripped re-match: peel known one-shot prefixes and re-test
		// the inner command, catching the most common agent wrapper patterns.
		for (const candidate of candidates) {
			const inner = stripKnownWrappers(candidate);
			if (inner && inner !== candidate) {
				regex.lastIndex = 0;
				if (regex.test(inner)) {
					return {
						block: true,
						message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
						suggestedTool: rule.tool,
					};
				}
			}
		}
	}

	return { block: false };
}
