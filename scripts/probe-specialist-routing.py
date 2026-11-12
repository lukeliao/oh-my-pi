#!/usr/bin/env python3
"""End-to-end probe: does the shipped prompt actually route work to a specialist,
and does that specialist's result come back?

Organic sessions are too sparse to judge a delegation change (a day of real work
produced ~9 task calls), so this runs fixed, no-naming prompts against a given
omp binary.

Pass condition per probe is deliberately narrow:
  exit == 0
  AND the expected specialist appears in `tasks[].agent`
  AND *that specialist's own child transcript* completed successfully
      (a successful `yield` receipt, or a final `stop` turn carrying text)
  AND the parent received that child's output (its final text shows up in a
      result the parent got back — not merely the child's name in the spawn args).

Anything that cannot be established is reported as `unknown`, never as PASS.

Usage:
    python3 scripts/probe-specialist-routing.py [--omp PATH] [--workdir DIR] [--keep]
    python3 scripts/probe-specialist-routing.py --self-test

`--self-test` feeds synthetic transcripts through the same analysis and asserts
the known false-positive shapes stay rejected:
  1. expected specialist aborted while a sibling scout delivered
  2. a child that only produced process text (aborted mid-turn)
  3. a parent that only references the child's name from the spawn arguments
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

SESSIONS = os.path.expanduser("~/.omp/agent/sessions")

PROBES = {
    "theorist": {
        "prompt": (
            "一个 7 自由度机械臂，末端有效质量 1.2 kg，接触刚度 1.0e5 N/m，以 0.3 m/s 撞上刚性表面。"
            "给出碰撞峰值力的闭式估计，说明假设与量级。直接给我结论和分析，不需要读任何仓库或文件。"
        ),
        "expect": "theorist",
    },
    "reviewer-small": {
        "prompt": "我改了一下 src/paginate.js，准备提交了。你看看这个改动行不行？",
        "expect": "reviewer",
    },
    "reviewer-substantial": {
        "prompt": "这次改动碰了 4 个文件，我准备提交了，帮我看一下有没有问题。",
        "expect": "reviewer",
    },
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SMALL_BASELINE = """export function page(items, pageNo, size) {
\treturn items.slice(pageNo * size, pageNo * size + size);
}
"""
SMALL_CHANGED = """export function page(items, pageNo, size) {
\tconst start = (pageNo - 1) * size;
\treturn items.slice(start, start + size - 1);
}
"""

SUBSTANTIAL = {
    "src/events.js": """export const EVENT_TYPES = ["created", "updated", "deleted", "archived"];

export function makeEvent(type, payload) {
\tif (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${type}`);
\treturn { type, payload, at: Date.now() };
}
""",
    "src/handler.js": """import { EVENT_TYPES } from "./events.js";

export function handleEvent(event, store) {
\tswitch (event.type) {
\t\tcase "created":
\t\t\tstore.insert(event.payload.id, event.payload);
\t\t\treturn { ok: true };
\t\tcase "updated":
\t\t\tstore.merge(event.payload.id, event.payload);
\t\t\treturn { ok: true };
\t\tcase "deleted":
\t\t\tstore.remove(event.payload.id);
\t\t\treturn { ok: true };
\t\tcase "archived":
\t\t\tstore.archive(event.payload.id);
\t\t\treturn { ok: true };
\t\tdefault:
\t\t\tthrow new Error(`unhandled event type ${event.type}`);
\t}
}

export function handleBatch(events, store) {
\tconst results = [];
\tfor (const event of events) results.push(handleEvent(event, store));
\treturn results;
}
""",
    "src/store.js": """export function createStore() {
\tconst rows = new Map();
\tconst archived = new Set();
\treturn {
\t\tinsert(id, value) { rows.set(id, { ...value }); },
\t\tmerge(id, patch) { rows.set(id, { ...(rows.get(id) ?? {}), ...patch }); },
\t\tremove(id) { rows.delete(id); },
\t\tarchive(id) { archived.add(id); },
\t\trows, archived,
\t};
}
""",
}

SUBSTANTIAL_CHANGED = {
    "src/events.js": """export const EVENT_TYPES = ["created", "updated", "deleted", "archived", "restored"];

export const EVENT_META = {
\tcreated: { mutates: true, audit: "insert" },
\tupdated: { mutates: true, audit: "merge" },
\tdeleted: { mutates: true, audit: "remove" },
\tarchived: { mutates: false, audit: "archive" },
\trestored: { mutates: false, audit: "unarchive" },
};

export function makeEvent(type, payload) {
\tif (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${type}`);
\treturn { type, payload, at: Date.now() };
}

export function isMutating(type) {
\treturn EVENT_META[type]?.mutates === true;
}
""",
    "src/handler.js": """import { EVENT_META } from "./events.js";

const ROUTES = {
\tcreated: (payload, store) => store.insert(payload.id, payload),
\tupdated: (payload, store) => store.merge(payload.id, payload),
\tdeleted: (payload, store) => store.remove(payload.id),
\tarchived: (payload, store) => store.archive(payload.id),
};

export function handleEvent(event, store) {
\tconst route = ROUTES[event.type];
\tif (!route) return { ok: false };
\troute(event.payload, store);
\treturn { ok: true, audit: EVENT_META[event.type]?.audit ?? null };
}

export function handleBatch(events, store) {
\tconst results = [];
\tconst audit = [];
\tfor (const event of events) {
\t\tconst result = handleEvent(event, store);
\t\tresults.push(result);
\t\tif (result.ok) audit.push({ id: event.payload.id, op: result.audit });
\t}
\treturn { results, audit };
}

export function summarize(results) {
\tconst ok = results.filter(r => r.ok).length;
\treturn { ok, failed: results.length - ok };
}
""",
    "src/store.js": """export function createStore() {
\tconst rows = new Map();
\tconst archived = new Set();
\treturn {
\t\tinsert(id, value) { rows.set(id, { ...value }); },
\t\tmerge(id, patch) { rows.set(id, { ...(rows.get(id) ?? {}), ...patch }); },
\t\tremove(id) { rows.delete(id); },
\t\tarchive(id) { archived.add(id); },
\t\tunarchive(id) { archived.delete(id); },
\t\trows, archived,
\t};
}
""",
    "src/index.js": """import { handleBatch, summarize } from "./handler.js";
import { createStore } from "./store.js";
import { makeEvent } from "./events.js";

const store = createStore();
const events = [
\tmakeEvent("created", { id: 1, name: "a" }),
\tmakeEvent("archived", { id: 1 }),
\tmakeEvent("restored", { id: 1 }),
];
const { results, audit } = handleBatch(events, store);
export { store, results, audit, summarize };
""",
}


def write_files(root: str, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path) or root, exist_ok=True)
        with open(path, "w") as handle:
            handle.write(content)


def git(root: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def make_fixture(kind: str, root: str) -> None:
    os.makedirs(root, exist_ok=True)
    git(root, "init", "-q")
    git(root, "config", "user.email", "probe@example.com")
    git(root, "config", "user.name", "probe")
    if kind == "theorist":
        return
    if kind == "reviewer-small":
        write_files(root, {"src/paginate.js": SMALL_BASELINE})
        git(root, "add", "-A")
        git(root, "commit", "-qm", "add page()")
        write_files(root, {"src/paginate.js": SMALL_CHANGED})
        return
    write_files(root, SUBSTANTIAL)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "event pipeline baseline")
    write_files(root, SUBSTANTIAL_CHANGED)


# ---------------------------------------------------------------------------
# Transcript analysis
# ---------------------------------------------------------------------------


def _entries(path: str):
    for line in open(path, errors="ignore"):
        try:
            yield json.loads(line)
        except ValueError:
            continue


def spawned_agents(session: str) -> list[dict]:
    """`tasks[]` items: which agent was requested, under which child name."""
    out: list[dict] = []
    for entry in _entries(session):
        if entry.get("type") != "message":
            continue
        for block in entry.get("message", {}).get("content", []):
            if not isinstance(block, dict) or block.get("type") not in ("toolCall", "tool_use", "tool-call"):
                continue
            if block.get("name") != "task":
                continue
            call = block.get("arguments") or block.get("input") or {}
            if isinstance(call, str):
                try:
                    call = json.loads(call)
                except ValueError:
                    call = {}
            items = call.get("tasks") if isinstance(call.get("tasks"), list) else [call]
            for item in items:
                if isinstance(item, dict):
                    out.append({"agent": item.get("agent") or "task", "name": item.get("name")})
    return out


def child_verdict(path: str) -> dict:
    """Did this child finish, and with what? Content-based, not stopReason-only."""
    stop = "no-turn"
    text_parts: list[str] = []
    yield_calls: set[str] = set()
    yield_ok = 0
    yield_err = 0
    for entry in _entries(path):
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        role = message.get("role")
        if role == "assistant":
            stop = message.get("stopReason") or "unknown"
            for block in message.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                if block.get("type") in ("toolCall", "tool_use", "tool-call") and block.get("name") == "yield":
                    call_id = block.get("id") or block.get("toolCallId")
                    if call_id:
                        yield_calls.add(call_id)
        elif role == "toolResult" and message.get("toolName") == "yield":
            call_id = message.get("toolCallId")
            if call_id in yield_calls or not yield_calls:
                if message.get("isError"):
                    yield_err += 1
                else:
                    yield_ok += 1
    final_text = "\n".join(part for part in text_parts if part.strip())
    completed = yield_ok > 0 or (stop == "stop" and len(final_text.strip()) >= 200)
    return {
        "stop": stop,
        "text": final_text.strip(),
        "yield_ok": yield_ok,
        "yield_err": yield_err,
        "completed": completed,
    }


def analyze(session: str) -> dict:
    """Map every spawned task item to its child transcript and verdict."""
    stem = session[: -len(".jsonl")]
    children = {}
    for path in glob.glob(os.path.join(stem, "*.jsonl")):
        name = os.path.basename(path)[: -len(".jsonl")]
        if name.startswith("__"):
            continue
        children[name] = child_verdict(path)

    items = spawned_agents(session)
    # Attach a name when the model omitted it and exactly one child exists.
    if len(items) == 1 and not items[0]["name"] and len(children) == 1:
        items[0]["name"] = next(iter(children))
    for item in items:
        item["child"] = children.get(item["name"]) if item["name"] else None
    return {"items": items, "children": children}


def receipt_check(session: str, child_text: str) -> str:
    """Did the parent actually receive this child's output?

    Looks for a non-acknowledgement tool result that carries a distinctive slice
    of the child's own final text. A spawn acknowledgement ("Spawned agent …"),
    or the child's name appearing in the spawn arguments, does not count.
    """
    if len(child_text.strip()) < 80:
        return "unknown"
    probe = " ".join(child_text.split())[:80]
    for entry in _entries(session):
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if message.get("role") != "toolResult" or message.get("toolName") != "task":
            continue
        body = " ".join(
            block.get("text", "")
            for block in message.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        flat = " ".join(body.split())
        if probe and probe in flat:
            return "received"
    return "not-received"


# ---------------------------------------------------------------------------
# Self-test: the false-positive shapes must stay rejected
# ---------------------------------------------------------------------------


def _write_session(path: str, entries: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")


def _msg(role: str, content: list[dict], **extra) -> dict:
    message = {"role": role, "content": content}
    message.update(extra)
    return {"type": "message", "message": message}


def self_test() -> int:
    root = tempfile.mkdtemp(prefix="probe-selftest-")
    failures: list[str] = []

    # Case 1: expected specialist aborted, a sibling scout delivered.
    session = os.path.join(root, "case1", "s.jsonl")
    _write_session(
        session,
        [
            _msg(
                "assistant",
                [
                    {
                        "type": "toolCall",
                        "name": "task",
                        "id": "c1",
                        "arguments": {
                            "tasks": [
                                {"agent": "reviewer", "name": "rev", "task": "review"},
                                {"agent": "scout", "name": "sc", "task": "look"},
                            ]
                        },
                    }
                ],
            ),
            _msg("toolResult", [{"type": "text", "text": "Spawned agent `rev`."}], toolName="task", isError=False),
        ],
    )
    _write_session(
        os.path.join(root, "case1", "s", "rev.jsonl"),
        [_msg("assistant", [{"type": "thinking", "thinking": "hm"}], stopReason="aborted")],
    )
    long_text = "scout found things " * 20
    _write_session(
        os.path.join(root, "case1", "s", "sc.jsonl"),
        [
            _msg("assistant", [{"type": "text", "text": long_text}], stopReason="stop"),
        ],
    )
    res = analyze(session)
    rev = next(item for item in res["items"] if item["agent"] == "reviewer")
    if rev["child"] and rev["child"]["completed"]:
        failures.append("case1: aborted reviewer counted as completed")

    # Case 2: child produced only process text and was aborted.
    session2 = os.path.join(root, "case2", "s.jsonl")
    _write_session(
        session2,
        [
            _msg(
                "assistant",
                [
                    {
                        "type": "toolCall",
                        "name": "task",
                        "id": "c2",
                        "arguments": {"tasks": [{"agent": "theorist", "name": "th", "task": "derive"}]},
                    }
                ],
            )
        ],
    )
    _write_session(
        os.path.join(root, "case2", "s", "th.jsonl"),
        [_msg("assistant", [{"type": "text", "text": "working on it " * 30}], stopReason="aborted")],
    )
    res2 = analyze(session2)
    th = res2["items"][0]["child"]
    if th and th["completed"]:
        failures.append("case2: aborted mid-turn text counted as delivered")

    # Case 3: parent only carries the child's name from the spawn arguments.
    session3 = os.path.join(root, "case3", "s.jsonl")
    _write_session(
        session3,
        [
            _msg(
                "assistant",
                [
                    {
                        "type": "toolCall",
                        "name": "task",
                        "id": "c3",
                        "arguments": {"tasks": [{"agent": "reviewer", "name": "rev", "task": "review"}]},
                    }
                ],
            ),
            _msg(
                "toolResult",
                [{"type": "text", "text": "Spawned agent `rev` (job `rev`)."}],
                toolName="task",
                isError=False,
            ),
        ],
    )
    _write_session(
        os.path.join(root, "case3", "s", "rev.jsonl"),
        [_msg("assistant", [{"type": "text", "text": "findings: " * 40}], stopReason="stop")],
    )
    verdict = receipt_check(session3, "findings: " * 40)
    if verdict == "received":
        failures.append("case3: spawn acknowledgement counted as a delivered result")

    # Case 4: a real result does count.
    session4 = os.path.join(root, "case4", "s.jsonl")
    body = "reviewer says: restored variant silently dropped at handler.js:12 " * 3
    _write_session(
        session4,
        [_msg("toolResult", [{"type": "text", "text": f"Result\n{body}"}], toolName="task", isError=False)],
    )
    if receipt_check(session4, body) != "received":
        failures.append("case4: a real result was not recognised as received")

    shutil.rmtree(root, ignore_errors=True)
    if failures:
        print("SELF-TEST FAILED")
        for line in failures:
            print("  -", line)
        return 1
    print("self-test ok: 3 false-positive shapes rejected, 1 true result recognised")
    return 0


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def session_dir(cwd: str) -> str:
    return os.path.join(SESSIONS, cwd.replace(os.sep, "-"))


def newest_session(cwd: str, since: float) -> str | None:
    files = [p for p in glob.glob(os.path.join(session_dir(cwd), "*.jsonl")) if os.path.getmtime(p) >= since]
    return max(files, key=os.path.getmtime) if files else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--omp", default="omp", help="omp binary to probe")
    parser.add_argument("--workdir", default=None, help="fixture root (default: a fresh temp dir)")
    parser.add_argument("--keep", action="store_true", help="keep fixtures for inspection")
    parser.add_argument("--self-test", action="store_true", help="run the analysis self-test only")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    root = args.workdir or tempfile.mkdtemp(prefix="omp-routing-probe-")
    results = []
    for kind, spec in PROBES.items():
        cwd = os.path.join(root, kind)
        shutil.rmtree(cwd, ignore_errors=True)
        make_fixture(kind, cwd)
        started = time.time() - 5
        print(f"[probe] {kind}: running…", flush=True)
        proc = subprocess.run(
            [args.omp, "-p", "--auto-approve", "--wait-async", spec["prompt"]],
            cwd=cwd,
            capture_output=True,
            text=True,
        )
        session = newest_session(cwd, started)
        verdict = analyze(session) if session else {"items": [], "children": {}}
        target = [item for item in verdict["items"] if item["agent"] == spec["expect"]]
        target_names = [item["name"] for item in target if item["name"]]
        completed = [item["child"]["completed"] for item in target if item["child"]]
        delivered = bool(completed) and all(completed)
        text = ""
        for item in target:
            if item["child"] and item["child"]["text"]:
                text = item["child"]["text"]
                break
        received = receipt_check(session, text) if session else "unknown"
        results.append(
            {
                "probe": kind,
                "expect": spec["expect"],
                "exit": proc.returncode,
                "agents": [item["agent"] for item in verdict["items"]],
                "target": ",".join(target_names) or "-",
                "delivered": delivered,
                "received": received,
                "all_children": ",".join(
                    f"{name}:{child['stop']}/{'ok' if child['completed'] else 'EMPTY'}"
                    for name, child in verdict["children"].items()
                )
                or "-",
            }
        )

    print()
    header = f"{'probe':22s} {'expect':10s} {'exit':4s} {'dispatched':22s} {'target':16s} {'child ok':8s} {'received':13s} children"
    print(header)
    for row in results:
        print(
            f"{row['probe']:22s} {row['expect']:10s} {row['exit']:<4d} {','.join(row['agents']) or '-':22s} "
            f"{row['target']:16s} {'yes' if row['delivered'] else 'no':8s} {row['received']:13s} {row['all_children']}"
        )

    passed = [
        row
        for row in results
        if row["exit"] == 0 and row["expect"] in row["agents"] and row["delivered"] and row["received"] == "received"
    ]
    print(
        f"\n{len(passed)}/{len(results)} probes passed "
        "(exit 0 + expected specialist dispatched + that child completed + parent received its text)."
    )
    print("`child ok` and `received` are per-probe requirements, not decoration: an aborted child,")
    print("a sibling's output, or a bare spawn acknowledgement all leave the row failing or unknown.")

    if not args.keep and args.workdir is None:
        shutil.rmtree(root, ignore_errors=True)
        print(f"(fixtures removed; pass --keep to keep {root})")
    return 0 if len(passed) == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
