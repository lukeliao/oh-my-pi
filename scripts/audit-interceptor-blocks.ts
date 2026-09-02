/**
 * Read-only audit: scan all session JSONLs for bash-interceptor "Blocked:"
 * tool results and tally (a) which rule fired, (b) per-session repeat blocks
 * of the same rule (variant-retry friction), (c) most-blocked commands.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/home/liao/.omp/agent/sessions";

const RULE_BY_SIGNATURE: Array<[string, string]> = [
	["instead of cat/head/tail", "read:cat/head/tail"],
	["instead of grep/rg", "grep:grep/rg"],
	["instead of find/fd", "glob:find/fd"],
	["sed -i", "edit:sed -i"],
	["perl -i", "edit:perl -i"],
	["awk -i inplace", "edit:awk -i inplace"],
	["instead of echo/cat redirection", "write:echo-redirect"],
	["instead of nohup or background", "hub:nohup-bg"],
	["for services, watchers", "hub:services"],
	["for watch mode", "hub:watch"],
	["build-products.sh", "build-discipline"],
];

function classify(text: string): string | undefined {
	for (const [sig, rule] of RULE_BY_SIGNATURE) {
		if (text.includes(sig)) return rule;
	}
	return text.includes("Blocked: ") ? "unknown" : undefined;
}

const ruleCounts = new Map<string, number>();
const commandCounts = new Map<string, number>();
const sessionRuleCounts = new Map<string, Map<string, number>>();
let files = 0;
let blocks = 0;

for (const project of fs.readdirSync(ROOT, { withFileTypes: true })) {
	if (!project.isDirectory()) continue;
	const projectDir = path.join(ROOT, project.name);
	for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
		if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
		const file = path.join(projectDir, entry.name);
		files++;
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const idx = line.indexOf("Blocked: ");
			if (idx === -1) continue;
			// Count only real tool results: user/assistant entries quoting or
			// restating a block message (pasted errors, thinking recaps) would
			// otherwise inflate the tallies.
			let entry: { message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.message?.role !== "toolResult") continue;
			const rule = classify(line);
			if (!rule) continue;
			blocks++;
			ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
			const perSession = sessionRuleCounts.get(file) ?? new Map<string, number>();
			perSession.set(rule, (perSession.get(rule) ?? 0) + 1);
			sessionRuleCounts.set(file, perSession);
			const cmdIdx = line.indexOf("Original command: ");
			if (cmdIdx !== -1) {
				const cmd = line
					.slice(cmdIdx + "Original command: ".length)
					.replace(/\\n.*/s, "")
					.slice(0, 90);
				commandCounts.set(cmd, (commandCounts.get(cmd) ?? 0) + 1);
			}
		}
	}
}

console.log(`scanned ${files} session files, ${blocks} interceptor blocks\n`);
console.log("by rule:");
for (const [rule, n] of [...ruleCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${rule}`);
console.log("\nsessions with repeat blocks of the same rule (variant-retry friction):");
let repeatSessions = 0;
for (const [file, per] of sessionRuleCounts) {
	for (const [rule, n] of per) {
		if (n >= 2) {
			repeatSessions++;
			console.log(`  ${path.basename(path.dirname(file)).slice(0, 19)} ${path.basename(file).slice(0, 24)} ${rule} x${n}`);
		}
	}
}
if (repeatSessions === 0) console.log("  (none)");
console.log("\ntop blocked commands:");
for (const [cmd, n] of [...commandCounts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
	console.log(`  ${String(n).padStart(4)}  ${cmd}`);
}
