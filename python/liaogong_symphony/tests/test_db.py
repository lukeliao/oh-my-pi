from __future__ import annotations

import pytest

from liaogong_symphony.db import Database, StaleLeaseError


def test_db_core_transitions(tmp_path):
    db = Database(tmp_path / "state.sqlite")
    try:
        worker = db.register_worker(worker_id="worker-1", host="host-a", labels=["default"], capacity=2)
        assert worker.running_count == 0

        first = db.enqueue_manual_work_item(identifier="LS-1", title="Title", body="Body", labels=["default"])
        duplicate = db.enqueue_manual_work_item(identifier="LS-1", title="Other", body="Other")
        assert first.accepted is True and first.duplicate is False
        assert duplicate.accepted is False and duplicate.duplicate is True

        claimed = db.claim_next_work_item(worker_labels=["default"])
        assert claimed is not None
        assert claimed.identifier == "LS-1"
        assert claimed.state == "leased"
        assert db.claim_next_work_item(worker_labels=["default"]) is None

        bundle = db.create_attempt_and_lease(
            work_item_id=claimed.id,
            worker_id="worker-1",
            workspace_path=str(tmp_path / "ws" / "repo"),
            session_dir=str(tmp_path / "ws" / ".omp-session"),
            lease_ttl_seconds=60.0,
        )
        assert bundle.work_item.state == "running"
        assert bundle.attempt.attempt_no == 1
        assert bundle.lease.state == "active"

        renewed = db.renew_lease(
            lease_id=bundle.lease.lease_id,
            fencing_token=bundle.lease.fencing_token,
            ttl_seconds=120.0,
        )
        assert renewed.state == "active"

        with pytest.raises(StaleLeaseError):
            db.finish_attempt_with_fencing(
                attempt_id=bundle.attempt.attempt_id,
                lease_id=bundle.lease.lease_id,
                fencing_token="wrong-token",
                attempt_state="failed",
                work_item_state="failed",
            )

        finished = db.finish_attempt_with_fencing(
            attempt_id=bundle.attempt.attempt_id,
            lease_id=bundle.lease.lease_id,
            fencing_token=bundle.lease.fencing_token,
            attempt_state="succeeded",
            work_item_state="succeeded",
            exit_reason="done",
            omp_session_file=str(tmp_path / "ws" / ".omp-session" / "session.jsonl"),
        )
        assert finished.work_item.state == "succeeded"
        assert finished.attempt.state == "succeeded"
        assert finished.lease.state == "released"
        assert db.get_worker("worker-1").running_count == 0

        db.enqueue_manual_work_item(identifier="LS-2", title="Retry", body="Body")
        retry_row = db.schedule_retry(identifier="LS-2", retry_due_at="2999-01-01T00:00:00.000000Z", error="later")
        assert retry_row is not None and retry_row.state == "retry_scheduled"
        assert retry_row.blocked_reason == "later"

        db.enqueue_manual_work_item(identifier="LS-3", title="Blocked", body="Body")
        blocked = db.mark_blocked(identifier="LS-3", reason="workflow_render_error")
        assert blocked is not None and blocked.state == "blocked"

        heartbeat = db.heartbeat_worker(worker_id="worker-1", state="draining", running_count=0)
        assert heartbeat is not None and heartbeat.state == "draining"
    finally:
        db.close()
