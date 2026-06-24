"""FastAPI operator surface for liaogong-symphony."""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .dashboard import render_dashboard
from .db import (
    AttemptLeaseBundle,
    AttemptRow,
    Database,
    EventRow,
    LeaseRow,
    StaleLeaseError,
    WorkerRow,
    WorkItemRecord,
    WorkItemRow,
)
from .worker import WorkerPool
from .workflow import WorkflowStore
from .workspace import WorkspaceManager, sanitize


class WorkItemCreateRequest(BaseModel):
    identifier: str
    title: str
    body: str
    repo_path: str | None = None
    labels: list[str] = Field(default_factory=list)
    priority: int = 100


class RetryRequest(BaseModel):
    retry_due_at: str | None = None


class WorkerRegisterRequest(BaseModel):
    worker_id: str
    host: str
    labels: list[str] = Field(default_factory=list)
    capacity: int
    state: str = "online"


class WorkerHeartbeatRequest(BaseModel):
    state: str
    running_count: int


class LeaseClaimRequest(BaseModel):
    worker_id: str
    worker_labels: list[str] = Field(default_factory=list)
    workspace_root: str


class LeaseRenewRequest(BaseModel):
    fencing_token: str
    ttl_seconds: float | None = None


class LeaseFinishRequest(BaseModel):
    attempt_id: str
    fencing_token: str
    attempt_state: str
    work_item_state: str
    exit_reason: str | None = None
    error: str | None = None
    blocked_reason: str | None = None
    omp_session_file: str | None = None


class EventAppendRequest(BaseModel):
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    work_item_id: int | None = None
    attempt_id: str | None = None


def create_app(settings: Settings | None = None, *, with_local_worker: bool = False) -> FastAPI:
    cfg = settings or get_settings()
    _validate_bind_auth(cfg)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        cfg.ensure_paths()
        db = Database(cfg.sqlite_path)
        workflow_store = WorkflowStore(cfg.workflow_path)
        workspace_manager = WorkspaceManager(cfg.workspace_root)
        worker_pool: WorkerPool | None = None
        bag: dict[str, Any] = {
            "settings": cfg,
            "db": db,
            "workflow_store": workflow_store,
            "workspace_manager": workspace_manager,
            "worker_pool": None,
            "ready": False,
        }
        app.state.bag = bag
        try:
            if with_local_worker:
                worker_pool = WorkerPool(
                    settings=cfg,
                    db=db,
                    workspace_manager=workspace_manager,
                    workflow_store=workflow_store,
                )
                await worker_pool.start()
                bag["worker_pool"] = worker_pool
            bag["ready"] = True
            yield
        finally:
            bag["ready"] = False
            if worker_pool is not None:
                await worker_pool.stop(drain_timeout=cfg.heartbeat_interval_seconds * 5, kill_timeout=5.0)
            db.close()

    app = FastAPI(title="liaogong-symphony", lifespan=lifespan)

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request) -> str:
        bag = request.app.state.bag
        records = await asyncio.to_thread(bag["db"].list_work_items, limit=200)
        workers = await asyncio.to_thread(bag["db"].list_workers)
        return render_dashboard(records=records, workers=workers)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/readyz")
    async def readyz(request: Request) -> dict[str, Any]:
        bag = request.app.state.bag
        if not bag.get("ready", False):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "not ready")
        return {"ok": True, "with_local_worker": bag.get("worker_pool") is not None}

    @app.post("/api/v1/work-items")
    async def create_work_item(payload: WorkItemCreateRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        result = await asyncio.to_thread(
            bag["db"].enqueue_manual_work_item,
            identifier=payload.identifier,
            title=payload.title,
            body=payload.body,
            repo_path=payload.repo_path,
            labels=payload.labels,
            priority=payload.priority,
        )
        worker_pool: WorkerPool | None = bag.get("worker_pool")
        if worker_pool is not None and result.accepted:
            worker_pool.wake()
        return {
            "accepted": result.accepted,
            "duplicate": result.duplicate,
            "work_item": _serialize_work_item_record(
                await asyncio.to_thread(bag["db"].get_work_item, payload.identifier)
            ),
        }

    @app.get("/api/v1/work-items")
    async def list_work_items(request: Request, limit: int = 100) -> dict[str, Any]:
        records = await asyncio.to_thread(request.app.state.bag["db"].list_work_items, limit=limit)
        return {"items": [_serialize_work_item_record(record) for record in records]}

    @app.get("/api/v1/work-items/{identifier}")
    async def show_work_item(identifier: str, request: Request) -> dict[str, Any]:
        record = await asyncio.to_thread(request.app.state.bag["db"].get_work_item, identifier)
        if record is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown work item")
        return _serialize_work_item_record(record)

    @app.post("/api/v1/work-items/{identifier}/cancel")
    async def cancel_work_item(identifier: str, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        row = await asyncio.to_thread(bag["db"].get_work_item_row, identifier)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown work item")
        worker_pool: WorkerPool | None = bag.get("worker_pool")
        if worker_pool is not None:
            await worker_pool.cancel_work_item(identifier)
        else:
            await asyncio.to_thread(bag["db"].request_cancel, identifier)
        record = await asyncio.to_thread(bag["db"].get_work_item, identifier)
        assert record is not None
        return _serialize_work_item_record(record)

    @app.post("/api/v1/work-items/{identifier}/retry")
    async def retry_work_item(identifier: str, payload: RetryRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        row = await asyncio.to_thread(bag["db"].get_work_item_row, identifier)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown work item")
        if row.state in ("leased", "running", "cancel_requested"):
            raise HTTPException(status.HTTP_409_CONFLICT, f"cannot retry from state {row.state}")
        retry_due_at = payload.retry_due_at or _utcnow()
        await asyncio.to_thread(bag["db"].schedule_retry, identifier=identifier, retry_due_at=retry_due_at, error=None)
        worker_pool: WorkerPool | None = bag.get("worker_pool")
        if worker_pool is not None:
            worker_pool.wake()
        record = await asyncio.to_thread(bag["db"].get_work_item, identifier)
        assert record is not None
        return _serialize_work_item_record(record)

    @app.post("/api/v1/workers/register")
    async def register_worker(payload: WorkerRegisterRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        worker = await asyncio.to_thread(
            request.app.state.bag["db"].register_worker,
            worker_id=payload.worker_id,
            host=payload.host,
            labels=payload.labels,
            capacity=payload.capacity,
            state=payload.state,
        )
        return {"worker": _serialize_worker(worker)}

    @app.post("/api/v1/workers/{worker_id}/heartbeat")
    async def heartbeat_worker(worker_id: str, payload: WorkerHeartbeatRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        worker = await asyncio.to_thread(
            request.app.state.bag["db"].heartbeat_worker,
            worker_id=worker_id,
            state=payload.state,
            running_count=payload.running_count,
        )
        if worker is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown worker")
        return {"worker": _serialize_worker(worker)}

    @app.post("/api/v1/leases/claim")
    async def claim_lease(payload: LeaseClaimRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        worker = await asyncio.to_thread(bag["db"].get_worker, payload.worker_id)
        if worker is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown worker")
        work_item = await asyncio.to_thread(bag["db"].claim_next_work_item, worker_labels=payload.worker_labels)
        if work_item is None:
            return {"claimed": False}
        layout = _describe_remote_workspace(payload.workspace_root, work_item.identifier)
        bundle: AttemptLeaseBundle = await asyncio.to_thread(
            bag["db"].create_attempt_and_lease,
            work_item_id=work_item.id,
            worker_id=payload.worker_id,
            workspace_path=str(layout["repo_path"]),
            session_dir=str(layout["session_dir"]),
            lease_ttl_seconds=bag["settings"].lease_ttl_seconds,
        )
        return {
            "claimed": True,
            "work_item": _serialize_work_item_row(bundle.work_item),
            "attempt": _serialize_attempt(bundle.attempt),
            "lease": _serialize_lease(bundle.lease),
        }

    @app.post("/api/v1/leases/{lease_id}/renew")
    async def renew_lease(lease_id: str, payload: LeaseRenewRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        try:
            lease = await asyncio.to_thread(
                bag["db"].renew_lease,
                lease_id=lease_id,
                fencing_token=payload.fencing_token,
                ttl_seconds=payload.ttl_seconds or bag["settings"].lease_ttl_seconds,
            )
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown lease") from None
        except StaleLeaseError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {"lease": _serialize_lease(lease)}

    @app.post("/api/v1/leases/{lease_id}/finish")
    async def finish_lease(lease_id: str, payload: LeaseFinishRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        bag = request.app.state.bag
        try:
            result = await asyncio.to_thread(
                bag["db"].finish_attempt_with_fencing,
                attempt_id=payload.attempt_id,
                lease_id=lease_id,
                fencing_token=payload.fencing_token,
                attempt_state=payload.attempt_state,
                work_item_state=payload.work_item_state,
                exit_reason=payload.exit_reason,
                error=payload.error,
                blocked_reason=payload.blocked_reason,
                omp_session_file=payload.omp_session_file,
            )
        except KeyError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown attempt or lease") from None
        except StaleLeaseError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {
            "work_item": _serialize_work_item_row(result.work_item),
            "attempt": _serialize_attempt(result.attempt),
            "lease": _serialize_lease(result.lease),
        }

    @app.post("/api/v1/events")
    async def append_event(payload: EventAppendRequest, request: Request) -> dict[str, Any]:
        _require_mutation_auth(request)
        event = await asyncio.to_thread(
            request.app.state.bag["db"].append_event,
            event_type=payload.event_type,
            payload=payload.payload,
            work_item_id=payload.work_item_id,
            attempt_id=payload.attempt_id,
        )
        return {"event": _serialize_event(event)}

    @app.get("/api/v1/events")
    async def list_events(request: Request, limit: int = 200) -> dict[str, Any]:
        events = await asyncio.to_thread(request.app.state.bag["db"].list_events, limit=limit)
        return {"events": [_serialize_event(event) for event in events]}

    return app


def drain_worker(db: Database, worker_id: str) -> WorkerRow | None:
    worker = db.get_worker(worker_id)
    if worker is None:
        return None
    return db.heartbeat_worker(worker_id=worker_id, state="draining", running_count=worker.running_count)


def _serialize_work_item_row(row: WorkItemRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "identifier": row.identifier,
        "title": row.title,
        "body": row.body,
        "source_kind": row.source_kind,
        "repo_path": row.repo_path,
        "labels": list(row.labels),
        "priority": row.priority,
        "state": row.state,
        "retry_due_at": row.retry_due_at,
        "blocked_reason": row.blocked_reason,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _serialize_attempt(row: AttemptRow) -> dict[str, Any]:
    return {
        "attempt_id": row.attempt_id,
        "work_item_id": row.work_item_id,
        "attempt_no": row.attempt_no,
        "worker_id": row.worker_id,
        "lease_id": row.lease_id,
        "workspace_path": row.workspace_path,
        "session_dir": row.session_dir,
        "omp_session_file": row.omp_session_file,
        "state": row.state,
        "started_at": row.started_at,
        "ended_at": row.ended_at,
        "last_event_at": row.last_event_at,
        "exit_reason": row.exit_reason,
        "error": row.error,
    }


def _serialize_lease(row: LeaseRow) -> dict[str, Any]:
    return {
        "lease_id": row.lease_id,
        "work_item_id": row.work_item_id,
        "attempt_id": row.attempt_id,
        "worker_id": row.worker_id,
        "fencing_token": row.fencing_token,
        "state": row.state,
        "acquired_at": row.acquired_at,
        "heartbeat_at": row.heartbeat_at,
        "expires_at": row.expires_at,
    }


def _serialize_worker(row: WorkerRow) -> dict[str, Any]:
    return {
        "worker_id": row.worker_id,
        "host": row.host,
        "labels": list(row.labels),
        "capacity": row.capacity,
        "running_count": row.running_count,
        "state": row.state,
        "last_seen_at": row.last_seen_at,
    }


def _serialize_event(row: EventRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "work_item_id": row.work_item_id,
        "attempt_id": row.attempt_id,
        "event_type": row.event_type,
        "payload": row.payload,
        "ts": row.ts,
    }


def _serialize_work_item_record(record: WorkItemRecord | None) -> dict[str, Any] | None:
    if record is None:
        return None
    return {
        "work_item": _serialize_work_item_row(record.work_item),
        "attempts": [_serialize_attempt(row) for row in record.attempts],
        "active_lease": _serialize_lease(record.active_lease) if record.active_lease is not None else None,
        "last_event": _serialize_event(record.last_event) if record.last_event is not None else None,
    }


def _require_mutation_auth(request: Request) -> None:
    bag = request.app.state.bag
    settings: Settings = bag["settings"]
    if settings.api_token is None:
        return
    header = request.headers.get("authorization", "")
    expected = f"Bearer {settings.api_token.get_secret_value()}"
    if not hmac.compare_digest(header, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bearer token")


def _validate_bind_auth(settings: Settings) -> None:
    if settings.api_token is not None:
        return
    if _is_loopback_host(settings.bind_host):
        return
    raise ValueError("non-loopback bind requires LIAOGONG_SYMPHONY_API_TOKEN")


def _is_loopback_host(host: str) -> bool:
    lowered = host.strip().lower()
    if lowered in {"localhost", "::1"}:
        return True
    try:
        return ipaddress.ip_address(lowered).is_loopback
    except ValueError:
        return False


def _describe_remote_workspace(workspace_root: str, identifier: str) -> dict[str, Path]:
    root = Path(workspace_root).resolve(strict=False)
    workspace_path = (root / sanitize(identifier)).resolve(strict=False)
    repo_path = workspace_path / "repo"
    session_dir = workspace_path / ".omp-session"
    try:
        repo_path.relative_to(root)
        session_dir.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "workspace root would escape remote layout") from exc
    return {"workspace_path": workspace_path, "repo_path": repo_path, "session_dir": session_dir}


def _utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


__all__ = ["create_app", "drain_worker"]
