/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

/** One bash-interceptor rule: commands matching `pattern` are redirected to `tool`. */
export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	/** Stable policy identity for repeat-block escalation; derived from `tool` when omitted. */
	policyKey?: string;
	allowSubcommands?: string[];
}

const EMPTY_STRING_ARRAY: string[] = [];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		// Only intercept when the query is one the glob tool can actually replace:
		// a name/type predicate present AND no glob-inexpressible predicate or
		// action anywhere in the segment (time: -newer/-mtime/-mmin; -size;
		// perms/owner; -delete/-exec/-ok; -ls/-fls/-printf output; fd --changed-*).
		// Those commands still run in bash because glob cannot express them.
		pattern:
			"^\\s*(?:find|fd|locate)\\s+(?!(?:[\\s\\S]*\\s)?-{1,2}(?:delete|exec\\w*|ok\\w*|newer\\w*|[mac]time|[acm]min|size|perm\\w*|owner|(?:no)?user|(?:no)?group|readable|writable|executable|links|inum|samefile|used|printf|fls|ls|fprint\\w*|changed-(?:within|before))\\b)(?=(?:[\\s\\S]*\\s)?(?:-name|-iname|-glob|--type|-type)\\b)",
		tool: "glob",
		message:
			"Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for name/type patterns (e.g. `find . -name '*.ts'` → glob `**/*.ts`).",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "bash",
		message:
			"Use `bash` with `name` instead of nohup or background shell syntax so the service stays observable and managed.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "bash",
		message: "Use `bash` with `name` for services, watchers, and debuggers; inspect with `read proc://<name>`.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "bash",
		message: "Use `bash` with `name` for watch mode so its output, input, and lifecycle stay managed.",
	},
];

export const cfgShellPath = register({ id: "shellPath", type: "string", default: undefined });

export const cfgBashEnabled = register({
	id: "bash.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash",
		description: "Enable the bash tool for shell command execution",
	},
});

export const cfgBashAllowCompoundCommands = register({
	id: "bash.allowCompoundCommands",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Allow Compound Commands",
		description:
			"Evaluate literal && chains per command; unmatched commands use normal bash approval policy and mode",
	},
});

export const cfgBashAutoBackgroundEnabled = register({
	id: "bash.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Auto-Background",
		description: "Automatically background long-running bash commands and deliver the result later",
	},
});

export const cfgBashGitGuard = register({
	id: "bash.gitGuard",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Git Guard",
		description:
			"Refuse git commands that discard or move shared work in the bash tool: stash, reset --hard or to another commit, and checkout/switch/restore outside a merge or rebase conflict",
	},
});

export const cfgBashPatterns = register({
	id: "bash.patterns",
	type: "array",
	default: [],
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Approval Patterns",
		description:
			"Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.",
	},
});

// Bash interceptor
export const cfgBashInterceptorEnabled = register({
	id: "bashInterceptor.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Interceptor",
		description: "Block shell commands that have dedicated tools",
	},
});

export const cfgBashInterceptorPatterns = register({
	id: "bashInterceptor.patterns",
	type: "array",
	default: DEFAULT_BASH_INTERCEPTOR_RULES,
});

// Extra interceptor rules checked before `patterns`; first matching rule wins,
// so a narrow extra can override a broad built-in default without copying the
// whole default rule set.
export const cfgBashInterceptorExtraPatterns = register({
	id: "bashInterceptor.extraPatterns",
	type: "array",
	default: [],
});

// WS2 permission rules — a stricter, Reasonix-style bash gate layered in
// front of the legacy bash patterns. Empty by default so behavior is
// unchanged until rules are configured.
export const cfgPermissionRules = register({
	id: "permission.rules",
	type: "array",
	default: [],
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Permission Rules",
		description:
			"Ordered bash permission rules. Each item has match and action fields. Matches use the form Bash, Bash=<literal>, Bash(<subject>), or Bash(<subject>:*). Actions: deny, ask, or allow. Empty by default (no-op).",
	},
});

// WS3 forbid_read — deny-list gate for the built-in path-reading tools
// (read, glob, grep, ast_grep). This is a process-internal mitigation, NOT
// an OS-level hard gate: it deliberately does NOT cover bash (beyond a
// conservative parameter subset in the interceptor), the eval kernel,
// browser, MCP, or extension tools. Empty by default so behavior is
// unchanged until paths are configured.
export const cfgSandboxForbidRead = register({
	id: "sandbox.forbidRead",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "shell",
		group: "Sandbox",
		label: "Forbid Reading Paths",
		description:
			"Absolute paths that the built-in read/glob/grep/search tools must not read. ${VAR}, ${VAR:-default}, and ~ expand; only absolute paths are accepted. A directory entry blocks everything beneath it. Covers only the built-in read/glob/grep/search tools — bash, eval, browser, MCP, and extension reads are NOT in scope.",
	},
});

export const cfgBashDirenv = register({
	id: "bash.direnv",
	type: "enum",
	values: ["auto", "off"] as const,
	default: "auto",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "direnv Auto-Load",
		description:
			"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed",
	},
});

export const cfgBashDirenvLoadTimeoutMs = register({
	id: "bash.direnvLoadTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "direnv Load Timeout (ms)",
		description:
			"Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env",
	},
});

// Shell output minimizer
export const cfgShellMinimizerEnabled = register({
	id: "shellMinimizer.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell Minimizer",
		description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
	},
});

export const cfgShellMinimizerSettingsPath = register({
	id: "shellMinimizer.settingsPath",
	type: "string",
	default: undefined,
});

export const cfgShellMinimizerOnly = register({
	id: "shellMinimizer.only",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerExcept = register({
	id: "shellMinimizer.except",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerMaxCaptureBytes = register({
	id: "shellMinimizer.maxCaptureBytes",
	type: "number",
	default: 4 * 1024 * 1024,
});

export const cfgShellMinimizerSourceOutlineLevel = register({
	id: "shellMinimizer.sourceOutlineLevel",
	type: "enum",
	values: ["default", "aggressive"] as const,
	default: "default",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell Minimizer Source Outline",
		description: "Source outline mode for cat/read of source files: default or aggressive",
	},
});

export const cfgShellMinimizerLegacyFilters = register({
	id: "shellMinimizer.legacyFilters",
	type: "boolean",
	default: undefined,
});

/** Shell output minimizer configuration (`shellMinimizer.*`). */
export const cfgShellMinimizer = combine({
	enabled: cfgShellMinimizerEnabled,
	settingsPath: cfgShellMinimizerSettingsPath,
	only: cfgShellMinimizerOnly,
	except: cfgShellMinimizerExcept,
	maxCaptureBytes: cfgShellMinimizerMaxCaptureBytes,
	sourceOutlineLevel: cfgShellMinimizerSourceOutlineLevel,
	legacyFilters: cfgShellMinimizerLegacyFilters,
});

/** Shell output minimizer configuration ({@link cfgShellMinimizer}). */
export type ShellMinimizerSettings = SettingValueOf<typeof cfgShellMinimizer>;

export const cfgBashAutoBackgroundThresholdMs = register({
	id: "bash.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});
