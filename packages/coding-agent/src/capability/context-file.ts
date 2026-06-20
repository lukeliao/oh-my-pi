/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface ContextFileFrontmatter {
	/** OKF-inspired concept type, e.g. ModuleOverview or SystemDesign */
	type?: string;
	title?: string;
	description?: string;
	resource?: string;
	tags?: string[];
	timestamp?: string;
}

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
	/** Optional machine-readable metadata parsed from YAML frontmatter */
	frontmatter?: ContextFileFrontmatter;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by scope: one user-level file, and one project-level file per directory depth.
	// Within each depth level, higher-priority providers shadow lower-priority ones.
	// OKF index.md files are concept gateways and must coexist with same-depth AGENTS.md.
	key: file =>
		file.level === "user"
			? "user"
			: path.basename(file.path).toLowerCase() === "index.md"
				? `project-index:${path.resolve(file.path)}`
				: `project:${Math.max(0, file.depth ?? 0)}`,
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});
