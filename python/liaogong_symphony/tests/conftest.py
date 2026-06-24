"""Common pytest fixtures for liaogong-symphony."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
if "liaogong_symphony" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "liaogong_symphony",
        _SRC_ROOT / "__init__.py",
        submodule_search_locations=[str(_SRC_ROOT)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["liaogong_symphony"] = module
    spec.loader.exec_module(module)

from liaogong_symphony.config import Settings, reset_settings_cache  # noqa: E402
from liaogong_symphony.db import Database, close_database  # noqa: E402
from liaogong_symphony.omp_runner import OmpRunResult  # noqa: E402


class SuccessRunner:
    def __init__(self, sink):
        self.sink = sink

    def run(self, request, *, on_cancel_ready=None):
        if on_cancel_ready is not None:
            on_cancel_ready(lambda: None)
        self.sink.append_event(
            event_type="agent_end",
            payload={"mode": "success"},
            work_item_id=request.work_item_id,
            attempt_id=request.attempt_id,
        )
        return OmpRunResult(
            outcome="completed",
            assistant_text="ok",
            blocked_reason=None,
            blocked_details=None,
            error=None,
            session_file=str(request.session_dir / "fake.jsonl"),
            resumed=False,
        )


class CancelRunner:
    def __init__(self, sink):
        self.sink = sink
        self.cancelled = False

    def cancel(self):
        self.cancelled = True

    def run(self, request, *, on_cancel_ready=None):
        if on_cancel_ready is not None:
            on_cancel_ready(self.cancel)
        import time

        while not self.cancelled:
            time.sleep(0.02)
        self.sink.append_event(
            event_type="agent_end",
            payload={"mode": "cancel"},
            work_item_id=request.work_item_id,
            attempt_id=request.attempt_id,
        )
        return OmpRunResult(
            outcome="cancelled",
            assistant_text=None,
            blocked_reason=None,
            blocked_details=None,
            error="cancelled by operator",
            session_file=str(request.session_dir / "cancel.jsonl"),
            resumed=False,
        )


class SlowRunner:
    def __init__(self, sink):
        self.sink = sink
        self.cancelled = False

    def cancel(self):
        self.cancelled = True

    def run(self, request, *, on_cancel_ready=None):
        if on_cancel_ready is not None:
            on_cancel_ready(self.cancel)
        import time

        for _ in range(200):
            if self.cancelled:
                break
            time.sleep(0.05)
        outcome = "cancelled" if self.cancelled else "completed"
        self.sink.append_event(
            event_type="agent_end",
            payload={"mode": outcome},
            work_item_id=request.work_item_id,
            attempt_id=request.attempt_id,
        )
        return OmpRunResult(
            outcome=outcome,
            assistant_text=None,
            blocked_reason=None,
            blocked_details=None,
            error="cancelled by operator" if self.cancelled else None,
            session_file=str(request.session_dir / "slow.jsonl"),
            resumed=False,
        )


def _workflow_text(*, body: str, after_create: str | None = None, before_run: str | None = None) -> str:
    hooks = []
    if after_create is not None:
        hooks.append("    after_create: |\n      " + after_create.replace("\n", "\n      "))
    if before_run is not None:
        hooks.append("    before_run: |\n      " + before_run.replace("\n", "\n      "))
    hooks_block = "\n".join(hooks)
    workspace = "workspace: {}" if not hooks else f"workspace:\n  hooks:\n{hooks_block}"
    return f"---\nqueue: {{}}\n{workspace}\nomp: {{}}\nworkers: {{}}\n---\n{body}"


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(_workflow_text(body="Work item ${identifier}\\n"), encoding="utf-8")
    values = {
        "LIAOGONG_SYMPHONY_SQLITE_PATH": str(tmp_path / "state.sqlite"),
        "LIAOGONG_SYMPHONY_WORKSPACE_ROOT": str(tmp_path / "workspaces"),
        "LIAOGONG_SYMPHONY_LOG_DIR": str(tmp_path / "logs"),
        "LIAOGONG_SYMPHONY_WORKFLOW_PATH": str(workflow_path),
        "LIAOGONG_SYMPHONY_BIND_HOST": "127.0.0.1",
        "LIAOGONG_SYMPHONY_BIND_PORT": "8090",
        "LIAOGONG_SYMPHONY_WORKER_ID": "test-worker",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    reset_settings_cache()
    yield values
    reset_settings_cache()
    close_database()


@pytest.fixture
def settings(env: dict[str, str]) -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


@pytest.fixture
def db(tmp_path: Path) -> Database:
    database = Database(tmp_path / "state.sqlite")
    yield database
    database.close()


@pytest.fixture
def workflow_path(tmp_path: Path) -> Path:
    return tmp_path / "WORKFLOW.md"


__all__ = ["CancelRunner", "SlowRunner", "SuccessRunner", "_workflow_text"]
