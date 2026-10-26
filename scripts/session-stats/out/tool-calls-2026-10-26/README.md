# Tool-call snapshot — 2026-10-26

Produced by `scripts/session-stats/tool-call-tiers.py` on the four x64
workstations, with a fixed sampling anchor so every host covers the same window:

```sh
ssh <host> 'python3 - 30 2026-10-26T04:00:00Z' < scripts/session-stats/tool-call-tiers.py
ssh <host> 'python3 - 0  2026-10-26T04:00:00Z' < scripts/session-stats/tool-call-tiers.py
```

| File | Host | Window |
| --- | --- | --- |
| `stats3-local-30.json` / `stats3-local-all.json` | liao-NUC12DCMi9 | 30 days / all time |
| `stats3-cnp6s-30.json` / `stats3-cnp6s-all.json` | liao-CNP6S | 30 days / all time |
| `stats3-ser9-30.json` / `stats3-ser9-all.json` | liao-SER9 | 30 days / all time |
| `stats3-desktop-30.json` / `stats3-desktop-all.json` | DESKTOP-07JFCG5 | 30 days / all time |
| `stats3-fleet-30.json` / `stats3-fleet-all.json` | fleet aggregate (jq over the four) | 30 days / all time |

## Reading it correctly

- Three tiers, **never summed**: `total_tool_calls` is tier 1 (top-level
  `toolCall` blocks) only; `eval_prelude` is a text-level regex over executed
  eval code; `xd_route` is the strict `path`-starts-with-`xd://` form, while
  `xd_mentions_weak` counts every occurrence in arguments (documentation text,
  tool descriptions…) and is not evidence of a call.
- `sessions_with_tool_calls` is counted after the window filter, but the corpus
  is append-only: entries written after the anchor that still carry an earlier
  timestamp can appear in a later run. Compare runs taken at the same anchor.
- Fleet totals: 30-day top-level 38,284; all-time 241,260. Tier-1 ranking
  (30 d): bash 11,358 · read 8,594 · grep 6,429 · edit 3,640 · advise 3,049 ·
  write 1,137 · glob 964 · eval 670 · wait 633 · yield 438.
- `computer`, `judge`, `workpool` are zero in all three tiers over the whole
  corpus; `browser` is non-zero (top-level + eval prelude + xd route).

For token-weighted and error-flagged analyses (per-tool token totals, edit
success rate, repeated reads, context residency), use the SQLite path instead:
`bun run stats:sync` then `bun run stats:tools|edits|followups`, or
`bun run stats:audit -- --no-llm`.
