#!/usr/bin/env bun
// semble-benchmark.ts — Compare omp vs omp-semble on targeted tasks.
// Each task runs with a hard per-task timeout; timed-out tasks are retried once.
// Usage: bun scripts/semble-benchmark.ts [--workspace <path>] [--model <model>]
//        [--timeout <seconds>] [--retries <n>] [--tasks <name,...>]

import * as fs from "node:fs";
import * as path from "node:path";

// ── CLI ──────────────────────────────────────────────────────────
function flag(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback ?? "";
}

const workspace = flag("workspace", "/home/liao/workspace/robotbridges");
const model = flag("model", "deepseek-v4-flash");
const perTaskTimeoutSec = parseInt(flag("timeout", "90")) || 90;
const maxRetries = parseInt(flag("retries", "1")) || 1;
const taskFilter = flag("tasks")
  ? new Set(flag("tasks").split(","))
  : null;

const wsName = "-workspace-" + path.basename(workspace);
const sessionDir = path.join(process.env.HOME!, ".omp", "agent", "sessions", wsName);

// ── Tasks ────────────────────────────────────────────────────────
interface Task {
  name: string;
  prompt: string;
  targetTool: string; // sembre tool we want agent to pick
  baselineTool: string; // what agent picks without sembre
}

const TASKS: Task[] = [
  {
    name: "tree",
    prompt:
      "Show the directory structure under src/ with 2 levels depth. Use a tree/directory tool that respects .gitignore.",
    targetTool: "semble_tree",
    baselineTool: "find",
  },
  {
    name: "pattern",
    prompt:
      "Find every main() function in C++ files under src/. Use an AST pattern-matching tool — prefer the one with compact output.",
    targetTool: "semble_find_pattern",
    baselineTool: "ast_grep",
  },
  {
    name: "deps",
    prompt:
      "List every local project file that src/robotbridgeserver/robotbridgeserver.cpp depends on. Use a dependency graph tool.",
    targetTool: "semble_deps",
    baselineTool: "read/grep",
  },
  {
    name: "impact",
    prompt:
      "If I rename src/CMakeLists.txt, which files in the project would be affected? Use a reverse-dependency analysis tool.",
    targetTool: "semble_impact",
    baselineTool: "search",
  },
  {
    name: "search",
    prompt:
      "Find code related to 'robot gripper control and vacuum handling' in src/. Use semantic search that finds by meaning, not exact text matching.",
    targetTool: "semble_search",
    baselineTool: "grep",
  },
  {
    name: "digest",
    prompt:
      "Compress this build output: 'Compiling src/foo.cpp... error: undefined reference to bar in line 42\\nCompiling src/baz.cpp... warning: unused variable x\\nLinking target... FAILED: 2 errors, 1 warning'. Use a digest tool for build/test/CI output.",
    targetTool: "semble_digest",
    baselineTool: "manual",
  },
  {
    name: "find_related",
    prompt:
      "In src/robotbridgeserver/robotbridgeserver.cpp, find semantically similar code elsewhere in the codebase. Use a find-related tool that locates code by embedding similarity.",
    targetTool: "semble_find_related",
    baselineTool: "grep",
  },
  {
    name: "encode",
    prompt:
      "Compute the Model2Vec embedding vector for the text 'robot bridge initialization'. Use an encode tool.",
    targetTool: "semble_encode",
    baselineTool: "N/A",
  },
];

// ── Types ────────────────────────────────────────────────────────
interface RunResult {
  task: string;
  variant: "omp" | "omp-semble";
  targetTool: string;
  targetUsed: boolean;
  toolsUsed: string[];
  totalTokens: number;
  wallMs: number;
  error: string | null;
  retries: number;
}

// ── Helpers ──────────────────────────────────────────────────────
function killProcessTree(pid: number) {
  try {
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const c of children) killProcessTree(parseInt(c));
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function getLatestSession(): string | null {
  try {
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    files.sort().reverse();
    return files.length > 0 ? path.join(sessionDir, files[0]) : null;
  } catch {
    return null;
  }
}

function parseSession(sessionPath: string): {
  tools: string[];
  totalTokens: number;
} {
  const tools: string[] = [];
  let totalTokens = 0;
  try {
    const content = fs.readFileSync(sessionPath, "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.message?.usage?.totalTokens) totalTokens += msg.message.usage.totalTokens;
        const tn = msg.message?.toolName || msg.toolName;
        if (tn && typeof tn === "string") tools.push(tn);
      } catch {}
    }
  } catch {}
  return { tools, totalTokens };
}

async function runWithTimeout(
	binary: string,
	prompt: string,
	timeoutMs: number,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
	const args = extraArgs.length
		? [binary, ...extraArgs, "-p", "--model", model, prompt]
		: [binary, "-p", "--model", model, prompt];
	const proc = Bun.spawn(args, {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc.pid);
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, timedOut };
}

// ── Run one task/binary combination ──────────────────────────────
async function runOne(task: Task, variant: "omp" | "omp-semble"): Promise<RunResult> {
  const binary = variant === "omp" ? "omp" : "omp-semble";
  const startTs = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const args = variant === "omp" ? ["--tools", "read,bash,edit,write,find,search,ast_grep,lsp,task,todo,web_search,browser,ask"] : [];
    const { timedOut } = await runWithTimeout(binary, task.prompt, perTaskTimeoutSec * 1000, args);

    if (timedOut && attempt < maxRetries) {
      process.stderr.write(` ⌛`);
      continue;
    }

    const wallMs = Date.now() - startTs;

    // Find session file created after this run started
    // Wait briefly for the file to be flushed
    await new Promise((r) => setTimeout(r, 1000));
    let sessionPath: string | null = null;
    try {
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files.sort().reverse()) {
        const stat = fs.statSync(path.join(sessionDir, f));
        if (stat.mtimeMs >= startTs - 5000) { // within 5s before start
          sessionPath = path.join(sessionDir, f);
          break;
        }
      }
    } catch {}

    if (!sessionPath) {
      return {
        task: task.name,
        variant,
        targetTool: task.targetTool,
        targetUsed: false,
        toolsUsed: [],
        totalTokens: 0,
        wallMs,
        error: timedOut ? "timeout" : "no session file",
        retries: attempt,
      };
    }

    const { tools, totalTokens } = parseSession(sessionPath);

    return {
      task: task.name,
      variant,
      targetTool: task.targetTool,
      targetUsed: tools.includes(task.targetTool),
      toolsUsed: tools,
      totalTokens,
      wallMs,
      error: timedOut ? "timeout (partial)" : null,
      retries: attempt,
    };
  }

  return {
    task: task.name,
    variant,
    targetTool: task.targetTool,
    targetUsed: false,
    toolsUsed: [],
    totalTokens: 0,
    wallMs: Date.now() - start,
    error: "timeout after retries",
    retries: maxRetries,
  };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const filtered = taskFilter ? TASKS.filter((t) => taskFilter.has(t.name)) : TASKS;

  console.log(`semble-benchmark | workspace=${path.basename(workspace)} | model=${model}`);
  console.log(`timeout=${perTaskTimeoutSec}s | retries=${maxRetries} | tasks=${filtered.length}`);
  console.log("=".repeat(72));

  const allResults: RunResult[] = [];

  for (const task of filtered) {
    process.stdout.write(`${task.name.padEnd(10)} `);

    // Run omp first (baseline)
    const omp = await runOne(task, "omp");
    process.stdout.write(`omp:${omp.totalTokens.toLocaleString().padStart(7)}T `);

    // Small gap to avoid session file race
    await new Promise((r) => setTimeout(r, 1500));

    // Run omp-semble
    const sbl = await runOne(task, "omp-semble");
    const delta = sbl.totalTokens - omp.totalTokens;
    const pct =
      omp.totalTokens > 0
        ? ((delta / omp.totalTokens) * 100).toFixed(0)
        : "N/A";

    const status =
      sbl.error && !sbl.totalTokens
        ? `💥 ${sbl.error}`
        : sbl.targetUsed
          ? `✅ ${task.targetTool}`
          : `❌ not selected`;

    process.stdout.write(
      `sbl:${sbl.totalTokens.toLocaleString().padStart(7)}T Δ${delta >= 0 ? "+" : ""}${delta.toLocaleString()} (${pct}%) ${status}\n`,
    );

    allResults.push(omp, sbl);

    // Gap between tasks
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ── Summary table ────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  console.log(
    "task".padEnd(10) +
      "omp(T)".padStart(10) +
      "sbl(T)".padStart(10) +
      "Δ(T)".padStart(10) +
      "hit".padEnd(8) +
      "action",
  );

  for (const task of filtered) {
    const omp = allResults.filter((r) => r.task === task.name && r.variant === "omp");
    const sbl = allResults.filter((r) => r.task === task.name && r.variant === "omp-semble");

    const avgO = Math.round(omp.reduce((s, r) => s + r.totalTokens, 0) / omp.length);
    const avgS = Math.round(sbl.reduce((s, r) => s + r.totalTokens, 0) / sbl.length);
    const hit = sbl.every((r) => r.targetUsed);
    const anyHit = sbl.some((r) => r.targetUsed);

    let action = "";
    if (!anyHit) action = "🔧 rewrite description";
    else if (!hit) action = "⚠️ inconsistent selection";
    else if (avgS < avgO) action = "✅ keep, tokens saved";
    else action = "⚡ check output quality";

    console.log(
      task.name.padEnd(10) +
        avgO.toLocaleString().padStart(10) +
        avgS.toLocaleString().padStart(10) +
        ((avgS - avgO) >= 0 ? "+" : "") +
        (avgS - avgO).toLocaleString().padStart(9) +
        (hit ? "✅  " : anyHit ? "⚠️  " : "❌  ").padEnd(6) +
        action,
    );
  }

  // ── Recommendations ───────────────────────────────────────────
  console.log("\nRecommendations:");
  for (const task of filtered) {
    const sbl = allResults.filter((r) => r.task === task.name && r.variant === "omp-semble");
    if (sbl.every((r) => !r.targetUsed)) {
      console.log(
        `  ${task.targetTool}: never selected — rewrite description to differentiate from built-in ${task.baselineTool}`,
      );
    }
  }
}

await main();
