"""Command-line interface for liaogong-symphony."""

from __future__ import annotations

import asyncio
import json
import signal
import sys
from pathlib import Path
from typing import Any

import click
import uvicorn

from .config import Settings, get_settings
from .db import Database
from .server import create_app, drain_worker
from .worker import ConductorClient, PullWorker
from .workflow import WorkflowStore
from .workspace import WorkspaceManager


def _settings_or_die() -> Settings:
    try:
        return get_settings()
    except Exception as exc:
        click.echo(f"configuration error: {exc}", err=True)
        sys.exit(2)


@click.group()
def main() -> None:
    """liaogong-symphony control surface."""


@main.command()
@click.option(
    "--with-local-worker", is_flag=True, default=False, help="Start one embedded local worker alongside the API server."
)
def serve(with_local_worker: bool) -> None:
    """Run the conductor API."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    app = create_app(cfg, with_local_worker=with_local_worker)
    uvicorn.run(app, host=cfg.bind_host, port=cfg.bind_port, log_config=None)


@main.command()
@click.option("--conductor-url", required=True, help="Base URL of the central conductor API.")
@click.option("--worker-id", default=None, help="Override worker id for this process.")
@click.option("--labels", default=None, help="Comma-separated worker labels.")
@click.option("--capacity", type=click.IntRange(min=1), default=None, help="Override worker concurrency.")
@click.option("--api-token", default=None, help="Bearer token for the central conductor API.")
def worker(
    conductor_url: str, worker_id: str | None, labels: str | None, capacity: int | None, api_token: str | None
) -> None:
    """Run a pull worker."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    update: dict[str, Any] = {}
    if worker_id is not None:
        update["worker_id"] = worker_id
    if labels is not None:
        update["worker_labels_raw"] = labels
    if capacity is not None:
        update["max_concurrency"] = capacity
    runtime_cfg = cfg.model_copy(update=update) if update else cfg
    conductor = ConductorClient(
        base_url=conductor_url,
        api_token=api_token
        or (runtime_cfg.api_token.get_secret_value() if runtime_cfg.api_token is not None else None),
        timeout_seconds=runtime_cfg.request_timeout_seconds,
    )
    pull = PullWorker(
        settings=runtime_cfg,
        conductor=conductor,
        workspace_manager=WorkspaceManager(runtime_cfg.workspace_root),
        workflow_store=WorkflowStore(runtime_cfg.workflow_path),
    )

    async def _run() -> None:
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop_event.set)
            except NotImplementedError:
                pass
        await pull.start()
        try:
            await stop_event.wait()
        finally:
            await pull.stop(drain_timeout=runtime_cfg.heartbeat_interval_seconds * 5, kill_timeout=5.0)

    asyncio.run(_run())


@main.command()
@click.option("--identifier", required=True)
@click.option("--title", required=True)
@click.option("--body-file", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=True)
@click.option("--repo-path", type=click.Path(path_type=Path), default=None)
@click.option("--labels", default="")
@click.option("--priority", type=int, default=100)
def enqueue(
    identifier: str,
    title: str,
    body_file: Path,
    repo_path: Path | None,
    labels: str,
    priority: int,
) -> None:
    """Enqueue a manual work item."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        result = db.enqueue_manual_work_item(
            identifier=identifier,
            title=title,
            body=body_file.read_text(encoding="utf-8"),
            repo_path=str(repo_path) if repo_path is not None else None,
            labels=[piece.strip() for piece in labels.split(",") if piece.strip()],
            priority=priority,
        )
        click.echo(
            json.dumps({"accepted": result.accepted, "duplicate": result.duplicate, "identifier": identifier}, indent=2)
        )
    finally:
        db.close()


@main.command()
def status() -> None:
    """Dump the work item table."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        records = db.list_work_items(limit=200)
        for record in records:
            latest = record.latest_attempt.state if record.latest_attempt is not None else "-"
            click.echo(
                f"{record.work_item.identifier:<24} state={record.work_item.state:<16} attempt={latest:<12} updated={record.work_item.updated_at}"
            )
    finally:
        db.close()


@main.command()
@click.argument("identifier")
def show(identifier: str) -> None:
    """Show one work item."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        record = db.get_work_item(identifier)
        if record is None:
            click.echo(f"unknown work item: {identifier}", err=True)
            sys.exit(2)
        click.echo(json.dumps(_jsonify(record), indent=2))
    finally:
        db.close()


@main.command()
@click.argument("identifier")
def cancel(identifier: str) -> None:
    """Cancel one work item."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        row = db.request_cancel(identifier)
        if row is None:
            click.echo(f"unknown work item: {identifier}", err=True)
            sys.exit(2)
        click.echo(json.dumps({"identifier": identifier, "state": row.state}, indent=2))
    finally:
        db.close()


@main.command()
@click.argument("identifier")
def retry(identifier: str) -> None:
    """Retry one work item immediately."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        row = db.get_work_item_row(identifier)
        if row is None:
            click.echo(f"unknown work item: {identifier}", err=True)
            sys.exit(2)
        row = db.schedule_retry(identifier=identifier, retry_due_at=_utcnow(), error=None)
        assert row is not None
        click.echo(
            json.dumps({"identifier": identifier, "state": row.state, "retry_due_at": row.retry_due_at}, indent=2)
        )
    finally:
        db.close()


@main.command("drain-worker")
@click.argument("worker_id")
def drain_worker_cmd(worker_id: str) -> None:
    """Put one worker into draining state."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = Database(cfg.sqlite_path)
    try:
        worker = drain_worker(db, worker_id)
        if worker is None:
            click.echo(f"unknown worker: {worker_id}", err=True)
            sys.exit(2)
        click.echo(json.dumps({"worker_id": worker.worker_id, "state": worker.state}, indent=2))
    finally:
        db.close()


def _jsonify(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonify(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonify(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {key: _jsonify(getattr(value, key)) for key in value.__dataclass_fields__}
    if isinstance(value, Path):
        return str(value)
    return value


def _utcnow() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


if __name__ == "__main__":
    main()
