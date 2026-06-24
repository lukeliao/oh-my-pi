from __future__ import annotations

import stat
import tempfile
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from liaogong_symphony.config import Settings
from liaogong_symphony.server import create_app

pytestmark = pytest.mark.skipif(
    "LIAOGONG_SYMPHONY_INTEGRATION" not in __import__("os").environ,
    reason="set LIAOGONG_SYMPHONY_INTEGRATION=1 to run integration smoke",
)


def test_integration_smoke():
    fake_rpc = """#!/usr/bin/env python3
import json
import sys
from pathlib import Path

args = sys.argv[1:]
session_dir = None
for index, value in enumerate(args):
    if value == "--session-dir" and index + 1 < len(args):
        session_dir = Path(args[index + 1])
        break
if session_dir is None:
    session_dir = Path.cwd() / ".omp-session"
session_dir.mkdir(parents=True, exist_ok=True)
session_file = session_dir / "fake-session.jsonl"
session_file.write_text("{}\\n", encoding="utf-8")

def send(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()

def response(req, **fields):
    payload = {"type": "response", "id": req["id"], "command": req["type"], "success": True}
    if fields:
        payload["data"] = fields
    send(payload)

send({"type": "ready"})
for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    msg_type = msg.get("type")
    if msg_type == "set_host_tools":
        response(msg, tools=[tool.get("name") for tool in msg.get("tools", [])])
    elif msg_type == "get_state":
        response(msg, sessionId="sess-1", sessionFile=str(session_file), steeringMode="one-at-a-time", followUpMode="one-at-a-time", interruptMode="immediate", isStreaming=False, isCompacting=False, autoCompactionEnabled=False, messageCount=0, queuedMessageCount=0, todoPhases=[], dumpTools=[])
    elif msg_type == "prompt":
        response(msg)
        assistant = {"role": "assistant", "content": "done"}
        send({"type": "agent_start"})
        send({"type": "turn_end", "message": assistant, "toolResults": []})
        send({"type": "agent_end", "messages": [assistant]})
    else:
        response(msg)
"""

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        workflow = root / "WORKFLOW.md"
        workflow.write_text(
            "---\n"
            "queue: {}\n"
            "workspace:\n"
            "  hooks:\n"
            "    after_create: |\n"
            "      printf created > marker.txt\n"
            "omp: {}\n"
            "workers: {}\n"
            "---\n"
            "Work item ${identifier}\\n${title}\\n${body}\\n",
            encoding="utf-8",
        )
        rpc_path = root / "fake_rpc.py"
        rpc_path.write_text(fake_rpc, encoding="utf-8")
        rpc_path.chmod(rpc_path.stat().st_mode | stat.S_IEXEC)
        settings = Settings(
            sqlite_path=root / "state.sqlite",
            workspace_root=root / "workspaces",
            log_dir=root / "logs",
            workflow_path=workflow,
            omp_command=str(rpc_path),
            worker_id="integration-worker",
            max_concurrency=1,
            heartbeat_interval_seconds=0.1,
            lease_ttl_seconds=1.0,
            task_timeout_seconds=5.0,
        )
        app = create_app(settings, with_local_worker=True)
        with TestClient(app) as client:
            created = client.post(
                "/api/v1/work-items",
                json={"identifier": "LS-1", "title": "Title", "body": "Body"},
            )
            assert created.status_code == 200
            end = time.time() + 5.0
            while time.time() < end:
                shown = client.get("/api/v1/work-items/LS-1").json()
                if shown["work_item"]["state"] == "succeeded":
                    break
                time.sleep(0.05)
            else:
                raise AssertionError(f"timed out waiting for success: {shown}")
            session_dir = root / "workspaces" / "LS-1" / ".omp-session"
            assert session_dir.exists()
            assert (root / "workspaces" / "LS-1" / "repo" / "marker.txt").read_text(encoding="utf-8") == "created"
            events = client.get("/api/v1/events").json()["events"]
            assert any(event["event_type"] == "agent_end" for event in events)
