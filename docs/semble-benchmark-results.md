# Semble Benchmark Results

**Date:** 2026-06-17  
**Workspace:** `/home/liao/workspace/robotbridges` (C++/Python robot bridge middleware, ~70 vendor subdirectories)  
**Model:** deepseek-v4-flash  
**Timeout:** 90s per task, 1 retry  
**OMP:** tools whitelisted to built-in only (`--tools read,bash,edit,write,find,search,ast_grep,lsp,task,todo,web_search,browser,ask`)  
**OMP-semble:** full tool set including 9 `semble_*` custom tools  

## Results

| Tool | omp (no sembre) | omp-semble (with sembre) | Δ | Hit |
|---|---|---|---|---|
| `semble_tree` | 97,309 | 80,488 | **-17%** | ✅ |
| `semble_find_pattern` | 155,963 | 115,946 | **-26%** | ✅ |
| `semble_deps` | 668,642 | 470,141 | **-30%** | ✅ |
| `semble_impact` | 297,997 | 154,207 | **-48%** | ✅ |
| `semble_search` | 212,359 | 124,848 | **-41%** | ✅ |
| `semble_digest` | 59,390 | 75,231 | +27% | ✅ |
| `semble_plan` | 677,758 | 1,009,208 | +49% | ✅ |
| `semble_find_related` | 579,226 | 534,700 | **-8%** | ✅ |
| `semble_encode` | 131,682 | 77,971 | **-41%** | ✅ |

**9/9 tools selected by agent. 7/9 reduce token usage. Net savings: ~240K tokens across all tasks.**

## Tool descriptions (iterated)

The descriptions were iterated based on earlier benchmark rounds where `semble_find_pattern` had 0% hit rate (agent always chose built-in `ast_grep`). After rewriting descriptions to include trigger conditions and differentiation from built-in alternatives, all 9 tools achieved 100% hit rate.

Key description patterns that work:
- Start with WHAT the tool does (verb phrase)
- Include WHEN to use it (trigger condition)
- Name the built-in alternative explicitly ("PREFER THIS over ast_grep")
- Mention the output format benefit ("compact output", "scored chunks")

## Methodology

Run from `agents_harness/oh-my-pi`:

```bash
# Full benchmark (all 9 tools)
bun scripts/semble-benchmark.ts --workspace /home/liao/workspace/robotbridges

# Subset
bun scripts/semble-benchmark.ts --workspace /home/liao/workspace/robotbridges --tasks tree,pattern

# Custom timeout/model
bun scripts/semble-benchmark.ts --workspace /home/liao/workspace/robotbridges --timeout 120 --model deepseek-v4-flash
```

The script runs each task with `omp` (without sembre tools) and `omp-semble` (with sembre tools), comparing total session tokens and whether the target tool was selected.

## Audit: semble_digest and semble_plan (2026-06-17)

### semble_digest

**Test input:** 18-line mixed build output (5 compile, 3 errors, 1 warning, 1 linker error chain)

| Dimension | Raw output | semble_digest | Agent manual digest |
|---|---|---|---|
| Noise filtered | — | ✅ stripped 5 Compiling lines | ✅ |
| Errors preserved | — | ✅ all 3 errors | ✅ |
| Vendor categorization | — | ❌ | ✅ ABB/Fanuc/UR |
| Error counting | — | ❌ | ✅ 3 errors, 1 warning, 1 linker |

**Verdict:** Useful for large build logs (filtering hundreds of noise lines), but for small output the agent re-summarizes anyway. Description updated to tell agent to trust the tool output directly.

### semble_plan

**Ground truth** for "add a new robot vendor bridge" — actual files needed:

| File | Role | sembre_plan hit? |
|---|---|---|
| `src/CMakeLists.txt` | `add_subdirectory` registration | ❌ |
| `src/include/mujinrobotbridge/robotcontrollerbridge.h` | Core interface | Partial (robotbridgecommon.h) |
| `src/sanyo/sanyoethercatbridge.cpp` | Simple template bridge | ✅ (#8) |
| `src/robotbridgeserver/robotbridgemain.cpp` | Entry point | ✅ (#7) |
| `src/robotbridgeserver/robotbridgedatabase.cpp` | Bridge factory/registry | ❌ |

**Top 8 recommendations accuracy:** 4/8 relevant (50%).
- Top hit (score 0.0353): Python migration file — completely wrong context
- False positives: jog executor, Python migration
- Missed: CMakeLists.txt, bridge database/factory

**Verdict:** Has signal but high noise. Semantic similarity captures "bridge" keyword but confuses Python/C++ contexts. Description updated to warn about false positives.
