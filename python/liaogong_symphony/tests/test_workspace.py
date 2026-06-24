from __future__ import annotations

from pathlib import Path

import pytest

from liaogong_symphony.workflow import WorkflowHooks
from liaogong_symphony.workspace import HookExecutionError, WorkspaceError, WorkspaceManager, sanitize


@pytest.mark.asyncio
async def test_workspace_layout_and_hooks(tmp_path: Path):
    manager = WorkspaceManager(tmp_path / "workspaces")
    assert sanitize("LS/1:? x") == "LS_1___x"
    hooks = WorkflowHooks(
        after_create="printf created > created.marker",
        before_run="test -f created.marker",
        after_run="printf post >> created.marker",
        before_remove="printf pre-remove >> created.marker",
        timeout_ms=5000,
    )
    layout = await manager.prepare(identifier="LS/1", hooks=hooks)
    assert layout.created_now is True
    assert layout.repo_path.joinpath("created.marker").read_text(encoding="utf-8") == "created"
    await manager.run_before_run(layout, hooks)
    await manager.run_after_run(layout, hooks)
    best_effort = WorkflowHooks(after_run="exit 9", before_remove="exit 5", timeout_ms=5000)
    await manager.run_after_run(layout, best_effort)
    removed = await manager.remove_workspace("LS/1", best_effort)
    assert removed is True
    with pytest.raises(WorkspaceError):
        manager.validate_launch_cwd(layout, layout.workspace_path)


@pytest.mark.asyncio
async def test_before_run_failure_is_fatal(tmp_path: Path):
    manager = WorkspaceManager(tmp_path / "workspaces")
    layout = manager.allocate("LS-2")
    with pytest.raises(HookExecutionError):
        await manager.run_before_run(layout, WorkflowHooks(before_run="exit 7", timeout_ms=5000))
