from __future__ import annotations

from pathlib import Path

import pytest

from liaogong_symphony.workflow import WorkflowError, WorkflowStore, WorkflowTemplateError, parse_workflow


def test_parse_workflow_requires_keys(tmp_path: Path):
    path = tmp_path / "WORKFLOW.md"
    path.write_text("---\nqueue: {}\nworkspace: {}\nomp: {}\n---\nBody\n", encoding="utf-8")
    with pytest.raises(WorkflowError):
        parse_workflow(path)


def test_parse_workflow_rejects_unbraced_placeholders(tmp_path: Path):
    path = tmp_path / "WORKFLOW.md"
    path.write_text("---\nqueue: {}\nworkspace: {}\nomp: {}\nworkers: {}\n---\nHello $identifier\n", encoding="utf-8")
    with pytest.raises(WorkflowTemplateError):
        parse_workflow(path)


def test_render_unknown_placeholder_blocks(tmp_path: Path):
    path = tmp_path / "WORKFLOW.md"
    path.write_text("---\nqueue: {}\nworkspace: {}\nomp: {}\nworkers: {}\n---\nHello ${oops}\n", encoding="utf-8")
    rendered = WorkflowStore(path).render_prompt(
        identifier="LS-1",
        title="Title",
        body="Body",
        workspace_path=tmp_path / "ws",
        session_dir=tmp_path / "ws" / ".omp-session",
        attempt_no=1,
        repo_path=None,
    )
    assert rendered.blocked is True
    assert rendered.blocked_reason == "workflow_render_error"
