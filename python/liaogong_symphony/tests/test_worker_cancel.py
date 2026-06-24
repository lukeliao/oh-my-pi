from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from liaogong_symphony.db import Database
from liaogong_symphony.worker import WorkerPool
from liaogong_symphony.workflow import WorkflowStore
from liaogong_symphony.workspace import WorkspaceManager

from .conftest import CancelRunner, _workflow_text


async def _wait_for_attempt(db: Database, identifier: str, timeout: float = 5.0):
    end = asyncio.get_running_loop().time() + timeout
    while True:
        record = db.get_work_item(identifier)
        if record is not None and record.latest_attempt is not None:
            return record
        if asyncio.get_running_loop().time() >= end:
            raise AssertionError("timed out waiting for attempt")
        await asyncio.sleep(0.05)


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
async def test_local_worker_cancel_path(settings, workflow_path: Path):
    workflow_path.write_text(_workflow_text(body="Work item ${identifier}\\n"), encoding="utf-8")
    db = Database(settings.sqlite_path)
    try:
        db.enqueue_manual_work_item(identifier="LS-2", title="Title", body="Body")
        pool = WorkerPool(
            settings=settings,
            db=db,
            workspace_manager=WorkspaceManager(settings.workspace_root),
            workflow_store=WorkflowStore(workflow_path),
            runner_factory=CancelRunner,
        )
        await pool.start()
        pool.wake()
        await _wait_for_attempt(db, "LS-2")
        fired = await pool.cancel_work_item("LS-2")
        assert fired is True
        await _wait_for_state(db, "LS-2", "cancelled")
        record = db.get_work_item("LS-2")
        assert record is not None and record.latest_attempt is not None
        assert record.latest_attempt.state == "cancelled"
        await pool.stop(drain_timeout=1.0, kill_timeout=0.5)
    finally:
        db.close()
