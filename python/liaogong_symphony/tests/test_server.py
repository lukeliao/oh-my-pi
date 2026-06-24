from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import SecretStr

from liaogong_symphony.config import Settings
from liaogong_symphony.server import create_app


def test_server_auth_and_work_item_endpoints(tmp_path: Path):
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text(
        "---\nqueue: {}\nworkspace: {}\nomp: {}\nworkers: {}\n---\nWork item ${identifier}\\n", encoding="utf-8"
    )
    settings = Settings(
        sqlite_path=tmp_path / "state.sqlite",
        workspace_root=tmp_path / "workspaces",
        log_dir=tmp_path / "logs",
        workflow_path=workflow,
        api_token=SecretStr("secret-token"),
        lease_ttl_seconds=60.0,
    )
    app = create_app(settings)
    headers = {"Authorization": "Bearer secret-token"}
    with TestClient(app) as client:
        assert client.get("/readyz").status_code == 200
        assert (
            client.post("/api/v1/work-items", json={"identifier": "LS-1", "title": "T", "body": "B"}).status_code == 401
        )
        created = client.post(
            "/api/v1/work-items",
            headers=headers,
            json={"identifier": "LS-1", "title": "Title", "body": "Body", "repo_path": "/repo", "labels": ["default"]},
        )
        assert created.status_code == 200 and created.json()["accepted"] is True
        assert client.get("/api/v1/work-items/LS-1").json()["work_item"]["state"] == "queued"
        assert (
            client.post("/api/v1/work-items/LS-1/cancel", headers=headers).json()["work_item"]["state"] == "cancelled"
        )
        assert (
            client.post("/api/v1/work-items/LS-1/retry", headers=headers, json={}).json()["work_item"]["state"]
            == "retry_scheduled"
        )
        assert (
            client.post(
                "/api/v1/workers/register",
                headers=headers,
                json={
                    "worker_id": "worker-1",
                    "host": "host-a",
                    "labels": ["default"],
                    "capacity": 1,
                    "state": "online",
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/workers/worker-1/heartbeat",
                headers=headers,
                json={"state": "online", "running_count": 0},
            ).status_code
            == 200
        )
        claim = client.post(
            "/api/v1/leases/claim",
            headers=headers,
            json={
                "worker_id": "worker-1",
                "worker_labels": ["default"],
                "workspace_root": str(tmp_path / "remote-workspaces"),
            },
        )
        assert claim.status_code == 200
        claim_payload = claim.json()
        assert claim_payload["claimed"] is True
        lease = claim_payload["lease"]
        attempt = claim_payload["attempt"]
        assert (
            client.post(
                f"/api/v1/leases/{lease['lease_id']}/renew",
                headers=headers,
                json={"fencing_token": lease["fencing_token"]},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/events",
                headers=headers,
                json={
                    "event_type": "agent_end",
                    "payload": {"ok": True},
                    "work_item_id": claim_payload["work_item"]["id"],
                    "attempt_id": attempt["attempt_id"],
                },
            ).status_code
            == 200
        )
        assert client.get("/api/v1/events").json()["events"][0]["event_type"] == "agent_end"
        finished = client.post(
            f"/api/v1/leases/{lease['lease_id']}/finish",
            headers=headers,
            json={
                "attempt_id": attempt["attempt_id"],
                "fencing_token": lease["fencing_token"],
                "attempt_state": "succeeded",
                "work_item_state": "succeeded",
                "exit_reason": "done",
                "omp_session_file": attempt["session_dir"] + "/session.jsonl",
            },
        )
        assert finished.status_code == 200
        assert client.get("/api/v1/work-items/LS-1").json()["work_item"]["state"] == "succeeded"
