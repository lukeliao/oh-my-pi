/**
 * AGENTS.md and index.md Provider
 *
 * Discovers standalone AGENTS.md and index.md files by walking up from cwd.
 * This handles files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, type ContextFileFrontmatter, contextFileCapability } from "../capability/context-file";
import { readDirEntries, readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md / index.md";
/** Regex matches YAML frontmatter delimited by --- on its own line at file start */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

export interface ParsedFrontmatter extends ContextFileFrontmatter {
	type: string;
	[key: string]: unknown;
}

export function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter | null; body: string } {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return { frontmatter: null, body: content };
	try {
		// Simple YAML subset parser — only handles the OKF fields we need.
		const frontmatter = parseSimpleYaml(match[1]);
		return { frontmatter, body: content.slice(match[0].length) };
	} catch {
		return { frontmatter: null, body: content };
	}
}

function parseSimpleYamlValue(value: string): unknown {
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map(item => item.trim().replace(/^['"]|['"]$/g, ""));
	}
	return value.replace(/^['"]|['"]$/g, "");
}

function parseSimpleYaml(yaml: string): ParsedFrontmatter {
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let inList = false;
	let listKey = "";
	let listItems: string[] = [];

	for (const line of lines) {
		// Skip empty lines and comments.
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Check for list item: "  - value" or "- value".
		const listMatch = trimmed.match(/^-\s+(.+)$/);
		if (listMatch) {
			if (!inList) continue;
			listItems.push(listMatch[1].trim().replace(/^['"]|['"]$/g, ""));
			continue;
		}

		// If we were accumulating a list and hit a non-list line, flush it.
		if (inList && listKey) {
			result[listKey] = listItems;
			inList = false;
			listKey = "";
			listItems = [];
		}

		// Key-value: "key: value" or "key:" (list follows).
		const kvMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			const value = kvMatch[2].trim();
			if (value === "") {
				inList = true;
				listKey = key;
				listItems = [];
			} else {
				result[key] = parseSimpleYamlValue(value);
			}
		}
	}

	// Flush trailing list.
	if (inList && listKey && listItems.length > 0) {
		result[listKey] = listItems;
	}

	return result as ParsedFrontmatter;
}

function pickContextFrontmatter(frontmatter: ParsedFrontmatter | null): ContextFileFrontmatter | undefined {
	if (!frontmatter) return undefined;
	const type = typeof frontmatter.type === "string" ? frontmatter.type : undefined;
	if (!type) return undefined;
	return {
		type,
		title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		resource: typeof frontmatter.resource === "string" ? frontmatter.resource : undefined,
		tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : undefined,
		timestamp: typeof frontmatter.timestamp === "string" ? frontmatter.timestamp : undefined,
		status: typeof frontmatter.status === "string" ? frontmatter.status : undefined,
		milestone: typeof frontmatter.milestone === "string" ? frontmatter.milestone : undefined,
		validation: typeof frontmatter.validation === "string" ? frontmatter.validation : undefined,
		decision_level: typeof frontmatter.decision_level === "string" ? frontmatter.decision_level : undefined,
	};
}

function buildContextFile(candidate: string, content: string, ctx: LoadContext): ContextFile | null {
	const parent = path.dirname(candidate);
	const baseName = parent.split(path.sep).pop() ?? "";

	if (baseName.startsWith(".")) return null;

	const { frontmatter, body } = parseFrontmatter(content);
	const fileDir = path.dirname(candidate);
	const calculatedDepth = calculateDepth(ctx.cwd, fileDir, path.sep);

	return {
		path: candidate,
		content: body,
		level: "project",
		depth: calculatedDepth,
		_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
		frontmatter: pickContextFrontmatter(frontmatter),
	};
}

async function candidateFileExists(directory: string, name: string): Promise<boolean> {
	const entries = await readDirEntries(directory);
	return entries.some(entry => entry.name === name && entry.isFile());
}
/**
 * Load standalone AGENTS.md and index.md files.
 */
async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// Walk up from cwd looking for AGENTS.md and index.md files.
	let current = ctx.cwd;

	while (true) {
		for (const name of ["AGENTS.md", "index.md"]) {
			if (!(await candidateFileExists(current, name))) continue;
			const candidate = path.join(current, name);
			const content = await readFile(candidate);
			if (content === null) continue;

			const item = buildContextFile(candidate, content, ctx);
			if (item) items.push(item);
		}

		if (current === (ctx.repoRoot ?? ctx.home)) break; // scanned repo root or home, stop

		// Move to parent directory
		const parent = path.dirname(current);
		if (parent === current) break; // Reached filesystem root
		current = parent;
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md and index.md files (Codex/Gemini style plus OKF indexes)",
	priority: 10,
	load: loadAgentsMd,
});
