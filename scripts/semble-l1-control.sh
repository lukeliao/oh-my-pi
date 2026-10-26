#!/usr/bin/env bash
# semble-l1-control.sh — keep the L1 promotion (loadMode: "essential") on the
# treatment machine only.
#
# WHY: L1 marks `semble_search` + `semble_deps` as top-level tools. The bundle
# ships that file to every workstation via install.sh; this script strips the two
# marked lines on control machines so they run the same binary/wrapper/prompts but
# keep the pre-L1 presentation (both tools stay behind xd://).
#
# SAFETY (learned the hard way, 2026-10-26): the first version shipped only a
# function definition over ssh and `$MARKER` expanded empty remotely, so
# `marker not in line` matched every line and emptied the file. This version
#
#   1. sends the script over **stdin** (no remote shell interpolation),
#   2. hardcodes the marker inside the heredoc,
#   3. refuses to write unless exactly EXPECTED lines match,
#   4. keeps a `.l1-treatment.bak` and restores from it when the live file is
#      empty or the assertion fails.
#
# Usage: semble-l1-control.sh [host ...]
set -uo pipefail

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ]; then
	HOSTS=(liao-cnp6s.tailad91fc.ts.net liao-ser9.tailad91fc.ts.net desktop)
fi

read -r -d '' REMOTE_PY <<'PY'
import os, shutil, sys

MARKER = "L1-experiment"   # literal: never interpolated by a shell
EXPECTED = 2               # exactly one line per promoted tool
p = os.path.expanduser("~/.omp/agent/tools/semble-rs/index.ts")
bak = p + ".l1-treatment.bak"

if not os.path.exists(p):
    print("MISSING", p)
    raise SystemExit(1)

size = os.path.getsize(p)
if size == 0:
    if os.path.exists(bak) and os.path.getsize(bak) > 0:
        shutil.copyfile(bak, p)
        print("RESTORED from backup (live file was empty)")
    else:
        print("EMPTY and no usable backup; refusing to touch", p)
        raise SystemExit(1)

src = open(p, encoding="utf-8").read()
lines = src.split("\n")
hits = [i for i, l in enumerate(lines) if MARKER in l]

if len(hits) == 0:
    body = src
    stripped = 0
else:
    if len(hits) != EXPECTED:
        print("REFUSING: %d marker lines, expected %d" % (len(hits), EXPECTED))
        raise SystemExit(1)
    if not os.path.exists(bak) or os.path.getsize(bak) == 0:
        shutil.copyfile(p, bak)
    body = "\n".join(l for l in lines if MARKER not in l)
    stripped = len(hits)

if stripped:
    open(p, "w", encoding="utf-8").write(body)

after = open(p, encoding="utf-8").read()
assert after.count(MARKER) == 0, "marker survived the strip"
assert after.count("\n") > 900, "file looks truncated: %d lines" % after.count("\n")
print(
    "OK stripped=%d lines=%d bytes=%d has_factory=%s has_savings=%s"
    % (
        stripped,
        after.count("\n"),
        len(after),
        "export default factory" in after,
        "semble_savings" in after,
    )
)
PY

for h in "${HOSTS[@]}"; do
	printf '== %s\n' "$h"
	timeout 90 ssh -o ConnectTimeout=8 "$h" 'python3 -' <<<"$REMOTE_PY" 2>&1 | sed 's/^/   /'
done
