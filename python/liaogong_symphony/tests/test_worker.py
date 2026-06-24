from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from liaogong_symphony.db import Database
from liaogong_symphony.worker import WorkerPool
from liaogong_symphony.workflow import WorkflowStore
from liaogong_symphony.workspace import WorkspaceManager

from .conftest import SuccessRunner, _workflow_text


async def _wait_for_state(db: Database, identifier: str, expected: str, timeout: float = 5.0):
    end = asyncio.get_running_loop().time() + timeout
    while True:
        row = db.get_work_item_row(identifier)
        if row is not None and row.state == expected:
            return row
        if asyncio.get_running_loop().time() >= end:
            raise AssertionError(f"timed out waiting for {identifier} -> {expected}; got {row.state if row else None}")
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_local_worker_success_path(settings, workflow_path: Path):
    workflow_path.write_text(
        _workflow_text(body="Work item ${identifier}\\n", after_create="printf created > created.marker"),
        encoding="utf-8",
    )
    db = Database(settings.sqlite_path)
    try:
        db.enqueue_manual_work_item(identifier="LS-1", title="Title", body="Body", repo_path="/repo")
        pool = WorkerPool(
            settings=settings,
            db=db,
            workspace_manager=WorkspaceManager(settings.workspace_root),
            workflow_store=WorkflowStore(workflow_path),
            runner_factory=SuccessRunner,
        )
        await pool.start()
        pool.wake()
        await _wait_for_state(db, "LS-1", "succeeded")
        record = db.get_work_item("LS-1")
        assert record is not None and record.latest_attempt is not None
        assert record.latest_attempt.state == "succeeded"
        assert (settings.workspace_root / "LS-1" / "repo" / "created.marker").read_text(encoding="utf-8") == "created"
        await pool.stop(drain_timeout=1.0, kill_timeout=0.5)
    finally:
        db.close()
