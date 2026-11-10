#!/usr/bin/env python3
"""Subagent dispatch inventory: who was spawned, and what the human had just asked.

Written for the 2026-11-10 harness audit and kept as the measurement tool for the
specialist-routing prompt change (theorist/reviewer descriptions plus the
`# Delegation` line in `prompts/tools/task.md`).

Usage:
    python3 scripts/session-stats/subagent-dispatch-stats.py [--since <iso>] [--json]

What it reports, and what it does NOT
-------------------------------------
* Every row is a `tasks[]` item of a `task` tool call; retries count again, so a
  502 storm inflates a row.
* Rows are filtered by the **timestamp of the assistant message carrying the
  call**, not by session-file mtime — a session that predates `--since` still
  contributes only its in-window dispatches.
* `named` counts rows whose nearest preceding *human* prompt mentions the agent.
  `role=user` messages are mostly injected content (session updates, async
  results, subagent assignments, IRC), so they are filtered out first; without
  that filter ~96% of prompts are machinery and every number is noise.
* `named` is a fact about the transcript only. It is NOT evidence either way
  about self-initiation: a dispatch can follow a prompt that named the agent
  three turns earlier and still be the model's own choice, and a dispatch that
  follows an unrelated prompt can be a retry of a named request. Rows with
  `named == 0` are printed as **candidates for human review**, never as a
  pass/fail threshold.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import glob
import json
import os
import sys

SESSIONS = os.path.expanduser("~/.omp/agent/sessions")

# Injected `role=user` prefixes. Kept as prefixes (not substrings) so a real
# prompt that merely quotes one of these words still counts as human.
INJECTED_PREFIXES = (
    "### Session update",
    "**agent**",
    "**user**",
    "**developer**",
    "_thinking:_",
    "//",
    "[async-result]",
    "[launch-completion]",
    "[irc]",
    "[compaction]",
    "[delegation]",
    "[progress]",
    "[system",
    "[advisory",
    "Complete the assignment below",
    "Complete assignment thoroughly",
    "Session update",
)

CANDIDATE_EXCERPT = 130


def is_human_prompt(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    if "shaken ~" in text:  # elided tool output echoed into a user turn
        return False
    return not text.startswith(INJECTED_PREFIXES)


def parse_since(value: str) -> datetime.datetime:
    parsed = datetime.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def entry_time(entry: dict) -> datetime.datetime | None:
    """Entry timestamp: ISO string on message entries, epoch milliseconds elsewhere."""
    raw = entry.get("timestamp")
    if isinstance(raw, (int, float)):
        return datetime.datetime.fromtimestamp(raw / 1000.0, datetime.timezone.utc)
    if isinstance(raw, str):
        try:
            parsed = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)
    return None


def text_of(message: dict) -> str:
    return " ".join(
        block.get("text", "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--since",
        default="2026-09-01",
        help="UTC instant; only messages at or after it are counted (ISO, e.g. 2026-11-10T20:00:00)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()
    since = parse_since(args.since)

    dispatches: list[dict] = []  # {agent, prompt, named}
    human_prompts = 0
    named_in_human: collections.Counter[str] = collections.Counter()
    sessions_with_dispatch: set[str] = set()
    sessions_502: set[str] = set()
    files_scanned = 0

    for path in glob.glob(os.path.join(SESSIONS, "**", "*.jsonl"), recursive=True):
        # Coarse gate only: a file last written before `since` cannot hold
        # in-window messages. Per-message timestamps below are authoritative.
        if datetime.datetime.fromtimestamp(os.path.getmtime(path), datetime.timezone.utc) < since:
            continue
        files_scanned += 1
        last_human = ""
        in_window = False
        with open(path, errors="ignore") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "message":
                    continue
                stamp = entry_time(entry)
                if stamp is not None and stamp < since:
                    continue
                if "502" in line:
                    sessions_502.add(path)
                in_window = True
                message = entry.get("message", {})
                role = message.get("role")

                if role == "user":
                    text = text_of(message)
                    if is_human_prompt(text):
                        human_prompts += 1
                        last_human = text.strip()
                        for name in ("theorist", "reviewer", "scout", "sonic"):
                            if name in last_human.lower():
                                named_in_human[name] += 1
                    continue

                if role != "assistant":
                    continue
                for block in message.get("content", []):
                    if not isinstance(block, dict) or block.get("type") not in ("toolCall", "tool_use", "tool-call"):
                        continue
                    if block.get("name") != "task":
                        continue
                    call_args = block.get("arguments") or block.get("input") or {}
                    if isinstance(call_args, str):
                        try:
                            call_args = json.loads(call_args)
                        except ValueError:
                            call_args = {}
                    items = call_args.get("tasks") if isinstance(call_args.get("tasks"), list) else [call_args]
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        agent = item.get("agent") or "task"
                        dispatches.append(
                            {
                                "agent": agent,
                                "prompt": last_human,
                                "named": agent.lower() in last_human.lower(),
                            }
                        )
                        sessions_with_dispatch.add(path)
        if not in_window:
            # Every message predated `since`; keep the file out of the 502 tally.
            sessions_502.discard(path)

    per_agent = collections.defaultdict(lambda: {"dispatches": 0, "named": 0})
    for row in dispatches:
        per_agent[row["agent"]]["dispatches"] += 1
        per_agent[row["agent"]]["named"] += int(row["named"])

    candidates = [row for row in dispatches if not row["named"] and row["agent"] in ("theorist", "reviewer")]

    if args.json:
        json.dump(
            {
                "since": since.isoformat(),
                "files_scanned": files_scanned,
                "sessions_with_dispatch": len(sessions_with_dispatch),
                "task_items": len(dispatches),
                "human_prompts": human_prompts,
                "prompts_naming_agent": dict(named_in_human),
                "session_files_with_502": len(sessions_502),
                "per_agent": per_agent,
                "candidates_for_review": candidates,
            },
            sys.stdout,
            indent=2,
            sort_keys=True,
        )
        print()
        return 0

    print(f"window: message timestamp >= {since.isoformat()}")
    print(f"session files scanned: {files_scanned} | sessions with a dispatch: {len(sessions_with_dispatch)}")
    print(f"task items in window: {len(dispatches)} | human prompts in window: {human_prompts}")
    print(f"prompts naming an agent: {dict(named_in_human)}")
    print(f"files holding an in-window message with literal '502': {len(sessions_502)}")
    print()
    print(f"{'agent':14s} {'items':>6s} {'named':>6s}")
    for agent, row in sorted(per_agent.items(), key=lambda kv: -kv[1]["dispatches"]):
        print(f"{agent:14s} {row['dispatches']:6d} {row['named']:6d}")
    print()
    if candidates:
        print(f"{len(candidates)} theorist/reviewer dispatch(es) with no agent name in the nearest human prompt.")
        print("Candidates for human review — read each prompt in context before calling it self-initiated:")
        for row in candidates:
            print(f"  [{row['agent']}] {row['prompt'][:CANDIDATE_EXCERPT].replace(chr(10), ' ')!r}")
    else:
        print("No theorist/reviewer dispatch lacks a naming prompt in this window.")
    print()
    print("This tool cannot decide self-initiation. It narrows the transcript to rows worth reading.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
