#!/usr/bin/env python3
"""Three-tier tool-usage counter over the local session corpus.

Complements `sync.py` + `analyze.py tools|edits|followups` (SQLite, token-aware,
error flags) and `audit.ts` (per-request usage, main/subagent split) — this
script exists only for the two tiers those do not count:

  1. top-level `toolCall` blocks (same corpus as `ss_tool_calls`, kept here so a
     single run prints all three tiers side by side),
  2. eval-internal prelude calls found in executed `eval` code
     (`computer.`/`browser.`/`judge(`/`agent(`/`workpool(`/`tool.<name>(`),
  3. strict `xd://` route targets (read|write|grep|glob whose `path` STARTS with
     `xd://`; other mentions of xd:// in arguments are reported separately as a
     weak "mentions" counter and must not be treated as calls).

Tiers are never summed: `total_tool_calls` counts tier 1 only.

Usage:
    python3 scripts/session-stats/tool-call-tiers.py [window_days] [end_iso]

      window_days  0/omitted = all time; 30 = the anchor minus 30 days
      end_iso      fixed anchor (e.g. 2026-10-26T04:00:00Z) so every machine is
                   sampled at the same instant; omit to anchor at "now"

Remote hosts (no repo checkout required — pipe the script over ssh):
    ssh cnp6s 'python3 - 30 2026-10-26T04:00:00Z' < scripts/session-stats/tool-call-tiers.py

Snapshot of the 2026-10-26 four-machine run: `out/tool-calls-2026-10-26/`.
"""
import json
import os
import re
import sys
import glob
import datetime
import collections

window_days = int(sys.argv[1]) if len(sys.argv) > 1 else 0
end = None
if len(sys.argv) > 2 and sys.argv[2]:
    end = datetime.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
cutoff = None
if window_days > 0:
    anchor = end or datetime.datetime.now(datetime.timezone.utc)
    cutoff = anchor - datetime.timedelta(days=window_days)

root = os.path.expanduser("~/.omp/agent/sessions")
paths = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True))

calls = collections.Counter()
sess_with = collections.defaultdict(set)
prelude = collections.Counter()       # eval-internal prelude/bridge calls (text-level regex)
prelude_sess = collections.defaultdict(set)
xd_route = collections.Counter()      # strict: read/write/grep/glob path argument STARTS with xd://
xd_route_sess = collections.defaultdict(set)
xd_mentions = collections.Counter()   # weak: xd:// appearing anywhere in arguments text
PRELUDE_RE = [
    ("eval:computer", re.compile(r"\bcomputer\.\w+\s*\(")),
    ("eval:browser", re.compile(r"\bbrowser\.\w+\s*\(")),
    ("eval:judge", re.compile(r"\bjudge(_batch)?\s*\(")),
    ("eval:completion", re.compile(r"\bcompletion\s*\(")),
    ("eval:agent", re.compile(r"\bagent\s*\(")),
    ("eval:workpool", re.compile(r"\bworkpool\s*\(")),
    ("eval:print", re.compile(r"\bprint\s*\(")),
]
TOOL_BRIDGE_RE = re.compile(r"\btool\.(\w+)\s*\(")
XD_RE = re.compile(r"xd://([A-Za-z_][\w-]*)")
XD_ROUTE_TOOLS = {"read", "write", "grep", "glob"}
total = 0
sessions_in_window = 0
bad_lines = 0
first_ts = None
last_ts = None


def parse_ts(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


for path in paths:
    seen = set()
    used = False
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    bad_lines += 1
                    continue
                ts = entry.get("timestamp")
                t = parse_ts(ts) if ts else None
                if end is not None and t is not None and t > end:
                    continue
                if t is not None:
                    if first_ts is None or t < first_ts:
                        first_ts = t
                    if last_ts is None or t > last_ts:
                        last_ts = t
                msg = entry.get("message") or {}
                if msg.get("role") != "assistant":
                    continue
                for block in msg.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        if cutoff is not None and t is not None and t < cutoff:
                            continue
                        name = block.get("name") or "?"
                        calls[name] += 1
                        total += 1
                        seen.add(name)
                        used = True
                        args = block.get("arguments") or {}
                        blob = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                        for m in XD_RE.finditer(blob):
                            xd_mentions[m.group(1)] += 1
                        if name in XD_ROUTE_TOOLS and isinstance(args, dict):
                            p = args.get("path")
                            if isinstance(p, str) and p.startswith("xd://"):
                                m = XD_RE.match(p)
                                if m:
                                    xd_route[m.group(1)] += 1
                                    xd_route_sess[m.group(1)].add(path)
                                    used = True
                        if name == "eval":
                            code = args.get("code", "") if isinstance(args, dict) else blob
                            for label, rx in PRELUDE_RE:
                                n = len(rx.findall(code))
                                if n:
                                    prelude[label] += n
                                    prelude_sess[label].add(path)
                                    used = True
                            for m in TOOL_BRIDGE_RE.finditer(code):
                                k = "eval:tool." + m.group(1)
                                prelude[k] += 1
                                prelude_sess[k].add(path)
                                used = True
    except OSError:
        continue
    if used:
        sessions_in_window += 1
    for n in seen:
        sess_with[n].add(path)

tools = []
for name, n in calls.most_common():
    s = len(sess_with[name])
    tools.append({
        "tool": name,
        "calls": n,
        "sessions": s,
        "session_pct": round(100.0 * s / sessions_in_window, 1) if sessions_in_window else 0.0,
    })

print(json.dumps({
    "machine": os.uname().nodename,
    "window_days": window_days,
    "session_files": len(paths),
    "sessions_with_tool_calls": sessions_in_window,
    "total_tool_calls": total,
    "bad_json_lines": bad_lines,
    "first_ts": first_ts.isoformat() if first_ts else None,
    "last_ts": last_ts.isoformat() if last_ts else None,
    "tools": tools,
    "note_total": "total_tool_calls counts top-level toolCall blocks only; eval_prelude/xd_route are separate",
    "sample_end": sys.argv[2] if len(sys.argv) > 2 else None,
    "eval_prelude": [
        {"name": k, "calls": n, "sessions": len(prelude_sess[k])}
        for k, n in prelude.most_common()
    ],
    "xd_route": [
        {"name": k, "calls": n, "sessions": len(xd_route_sess[k])}
        for k, n in xd_route.most_common()
    ],
    "xd_mentions_weak": [
        {"name": k, "mentions": n}
        for k, n in xd_mentions.most_common()
    ],
}, ensure_ascii=False, indent=1))
