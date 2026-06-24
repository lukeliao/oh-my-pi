"""Local and pull-worker execution loops for liaogong-symphony."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import Settings
from .db import AttemptLeaseBundle, Database, LeaseRow, StaleLeaseError, WorkerState, WorkItemRow
from .omp_runner import AttemptStateSink, OmpAttemptRunner, OmpRunRequest, OmpRunResult
from .workflow import WorkflowStore
from .workspace import HookExecutionError, WorkspaceError, WorkspaceManager

log = logging.getLogger(__name__)

PromptMode = Literal["local", "remote"]


@dataclass(slots=True, frozen=True)
class ClaimedAttempt:
    work_item_id: int
    identifier: str
    title: str
    body: str
    repo_path: str | None
    labels: tuple[str, ...]
    attempt_id: str
    attempt_no: int
    lease_id: str
    fencing_token: str
    workspace_path: str
    session_dir: str


class WorkerPool:
    """Embedded local dispatcher backed directly by the SQLite state store."""

    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        workspace_manager: WorkspaceManager,
        workflow_store: WorkflowStore,
        runner_factory: Callable[[AttemptStateSink], OmpAttemptRunner] = OmpAttemptRunner,
    ) -> None:
        self.settings = settings
        self.db = db
        self.workspace_manager = workspace_manager
        self.workflow_store = workflow_store
        self._runner_factory = runner_factory
        self.worker_id = settings.worker_id or f"local-{socket.gethostname()}"
        self.worker_labels = settings.worker_labels
        self.capacity = settings.max_concurrency
        self._workers: list[asyncio.Task[None]] = []
        self._wakeup = asyncio.Event()
        self._stop = asyncio.Event()
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._inflight: set[str] = set()
        self._inflight_lock = asyncio.Lock()
        self._cancel_hooks: dict[str, Callable[[], None]] = {}
        self._cancelled: set[str] = set()
        self._inflight_tasks: dict[asyncio.Task[None], str] = {}
        self._shutting_down = False
        self._shutdown_cancelled: set[str] = set()

    def wake(self) -> None:
        self._wakeup.set()

    async def start(self) -> None:
        await asyncio.to_thread(
            self.db.register_worker,
            worker_id=self.worker_id,
            host=socket.gethostname(),
            labels=self.worker_labels,
            capacity=self.capacity,
            state="online",
        )
        self._workers.append(asyncio.create_task(self._dispatch_loop(), name="liaogong-local-dispatch"))
        self._workers.append(asyncio.create_task(self._heartbeat_loop(), name="liaogong-local-heartbeat"))

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        self._shutting_down = True
        self._stop.set()
        self._wakeup.set()
        for task in self._workers:
            task.cancel()
        for task in self._workers:
            with suppress(asyncio.CancelledError):
                await task
        self._workers.clear()
        pending = list(self._inflight_tasks)
        if not pending:
            await asyncio.to_thread(
                self.db.heartbeat_worker,
                worker_id=self.worker_id,
                state="offline",
                running_count=0,
            )
            return
        _, still_running = await asyncio.wait(pending, timeout=drain_timeout)
        for task in still_running:
            identifier = self._inflight_tasks.get(task)
            if identifier is None:
                task.cancel()
                continue
            self._shutdown_cancelled.add(identifier)
            hook = self._cancel_hooks.pop(identifier, None)
            if hook is not None:
                await asyncio.to_thread(hook)
            else:
                task.cancel()
        with suppress(TimeoutError):
            await asyncio.wait(still_running, timeout=kill_timeout)
        await asyncio.to_thread(
            self.db.heartbeat_worker,
            worker_id=self.worker_id,
            state="offline",
            running_count=0,
        )

    async def inflight_snapshot(self) -> list[str]:
        async with self._inflight_lock:
            return sorted(self._inflight)

    async def cancel_work_item(self, identifier: str) -> bool:
        await asyncio.to_thread(self.db.request_cancel, identifier)
        self._cancelled.add(identifier)
        hook = self._cancel_hooks.pop(identifier, None)
        if hook is None:
            return False
        await asyncio.to_thread(hook)
        return True

    def _arm_cancel(self, identifier: str, hook: Callable[[], None]) -> None:
        if identifier in self._cancelled:
            hook()
            return
        self._cancel_hooks[identifier] = hook

    def _disarm_cancel(self, identifier: str) -> None:
        self._cancel_hooks.pop(identifier, None)

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            state: WorkerState = "draining" if self._shutting_down else "online"
            running_count = len(self._inflight_tasks)
            await asyncio.to_thread(
                self.db.heartbeat_worker,
                worker_id=self.worker_id,
                state=state,
                running_count=running_count,
            )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.settings.heartbeat_interval_seconds)
            except TimeoutError:
                pass

    async def _dispatch_loop(self) -> None:
        while not self._stop.is_set():
            await self._semaphore.acquire()
            claimed = await self._claim_next_unique()
            if claimed is None:
                self._semaphore.release()
                self._wakeup.clear()
                try:
                    await asyncio.wait_for(self._wakeup.wait(), timeout=10.0)
                except TimeoutError:
                    pass
                continue
            task = asyncio.create_task(self._run_attempt(claimed), name=f"liaogong-attempt-{claimed.identifier}")
            self._inflight_tasks[task] = claimed.identifier
            task.add_done_callback(self._attempt_done)

    def _attempt_done(self, task: asyncio.Task[None]) -> None:
        self._inflight_tasks.pop(task, None)
        self._semaphore.release()

    async def _claim_next_unique(self) -> WorkItemRow | None:
        row = await asyncio.to_thread(self.db.claim_next_work_item, worker_labels=self.worker_labels)
        if row is None:
            return None
        async with self._inflight_lock:
            self._inflight.add(row.identifier)
        return row

    async def _release(self, identifier: str) -> None:
        async with self._inflight_lock:
            self._inflight.discard(identifier)

    async def _run_attempt(self, item: WorkItemRow) -> None:
        bundle: AttemptLeaseBundle | None = None
        try:
            hooks = self.workflow_store.load().hooks
            layout = self.workspace_manager.allocate(item.identifier)
            bundle = await asyncio.to_thread(
                self.db.create_attempt_and_lease,
                work_item_id=item.id,
                worker_id=self.worker_id,
                workspace_path=str(layout.repo_path),
                session_dir=str(layout.session_dir),
                lease_ttl_seconds=self.settings.lease_ttl_seconds,
            )
            await asyncio.to_thread(
                self.db.upsert_workspace_ref,
                workspace_key=layout.workspace_key,
                worker_id=self.worker_id,
                workspace_path=str(layout.repo_path),
                session_dir=str(layout.session_dir),
            )
            await self.workspace_manager.run_after_create(layout, hooks)
            rendered = self.workflow_store.render_prompt(
                identifier=item.identifier,
                title=item.title,
                body=item.body,
                workspace_path=layout.workspace_path,
                session_dir=layout.session_dir,
                attempt_no=bundle.attempt.attempt_no,
                repo_path=Path(item.repo_path) if item.repo_path is not None else layout.repo_path,
            )
            if rendered.blocked:
                await asyncio.to_thread(
                    self.db.finish_attempt_with_fencing,
                    attempt_id=bundle.attempt.attempt_id,
                    lease_id=bundle.lease.lease_id,
                    fencing_token=bundle.lease.fencing_token,
                    attempt_state="blocked",
                    work_item_state="blocked",
                    blocked_reason=rendered.blocked_reason,
                    error=rendered.blocked_details,
                )
                return
            await self.workspace_manager.run_before_run(layout, hooks)
            runner = self._runner_factory(self.db)
            cancel_runner = getattr(runner, "cancel", lambda: None)
            renew_task = asyncio.create_task(self._renew_loop(item.identifier, bundle.lease, cancel_runner))
            try:
                result = await asyncio.to_thread(
                    lambda: runner.run(
                        OmpRunRequest(
                            attempt_id=bundle.attempt.attempt_id,
                            work_item_id=item.id,
                            identifier=item.identifier,
                            prompt="Please execute the current work item.",
                            cwd=layout.repo_path,
                            session_dir=layout.session_dir,
                            omp_command=self.settings.omp_command,
                            request_timeout=self.settings.request_timeout_seconds,
                            task_timeout=self.settings.task_timeout_seconds,
                            attempt_no=bundle.attempt.attempt_no,
                            append_system_prompt=rendered.prompt,
                        ),
                        on_cancel_ready=lambda hook: self._arm_cancel(item.identifier, hook),
                    )
                )
            finally:
                renew_task.cancel()
                with suppress(asyncio.CancelledError):
                    await renew_task
                self._disarm_cancel(item.identifier)
                await self.workspace_manager.run_after_run(layout, hooks)
            await asyncio.to_thread(self._finalize_local_result, item, bundle, result)
        except HookExecutionError as exc:
            if bundle is not None:
                await asyncio.to_thread(
                    self.db.append_event,
                    event_type="workspace_hook_error",
                    payload={
                        "hook": exc.result.hook_name,
                        "exit_code": exc.result.exit_code,
                        "stdout": exc.result.stdout,
                        "stderr": exc.result.stderr,
                        "timed_out": exc.result.timed_out,
                    },
                    work_item_id=item.id,
                    attempt_id=bundle.attempt.attempt_id,
                )
                await asyncio.to_thread(
                    self.db.finish_attempt_with_fencing,
                    attempt_id=bundle.attempt.attempt_id,
                    lease_id=bundle.lease.lease_id,
                    fencing_token=bundle.lease.fencing_token,
                    attempt_state="failed",
                    work_item_state="failed",
                    exit_reason=f"{exc.result.hook_name} hook failed",
                    error=exc.result.stderr or str(exc),
                )
            else:
                await asyncio.to_thread(self.db.mark_blocked, identifier=item.identifier, reason=str(exc))
        except WorkspaceError as exc:
            if bundle is not None:
                await asyncio.to_thread(
                    self.db.finish_attempt_with_fencing,
                    attempt_id=bundle.attempt.attempt_id,
                    lease_id=bundle.lease.lease_id,
                    fencing_token=bundle.lease.fencing_token,
                    attempt_state="failed",
                    work_item_state="failed",
                    exit_reason="workspace error",
                    error=str(exc),
                )
        except Exception as exc:
            log.exception("attempt failed", extra={"identifier": item.identifier})
            if bundle is not None:
                try:
                    await asyncio.to_thread(
                        self.db.finish_attempt_with_fencing,
                        attempt_id=bundle.attempt.attempt_id,
                        lease_id=bundle.lease.lease_id,
                        fencing_token=bundle.lease.fencing_token,
                        attempt_state="cancelled" if item.identifier in self._shutdown_cancelled else "failed",
                        work_item_state="cancelled" if item.identifier in self._shutdown_cancelled else "failed",
                        exit_reason="cancelled" if item.identifier in self._shutdown_cancelled else "runner exception",
                        error=str(exc),
                    )
                except StaleLeaseError:
                    log.warning("stale lease while finalizing exception", extra={"identifier": item.identifier})
            else:
                await asyncio.to_thread(self.db.mark_blocked, identifier=item.identifier, reason=str(exc))
        finally:
            self._cancelled.discard(item.identifier)
            self._shutdown_cancelled.discard(item.identifier)
            self._disarm_cancel(item.identifier)
            await self._release(item.identifier)

    async def _renew_loop(self, identifier: str, lease: LeaseRow, cancel_runner: Callable[[], None]) -> None:
        try:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.settings.heartbeat_interval_seconds)
                    return
                except TimeoutError:
                    pass
                try:
                    await asyncio.to_thread(
                        self.db.renew_lease,
                        lease_id=lease.lease_id,
                        fencing_token=lease.fencing_token,
                        ttl_seconds=self.settings.lease_ttl_seconds,
                    )
                    await asyncio.to_thread(
                        self.db.heartbeat_worker,
                        worker_id=self.worker_id,
                        state="draining" if self._shutting_down else "online",
                        running_count=len(self._inflight_tasks),
                    )
                except Exception:
                    log.exception("lease renew failed", extra={"identifier": identifier, "lease_id": lease.lease_id})
                    await asyncio.to_thread(cancel_runner)
                    return
        except asyncio.CancelledError:
            raise

    def _finalize_local_result(
        self,
        item: WorkItemRow,
        bundle: AttemptLeaseBundle,
        result: OmpRunResult,
    ) -> None:
        outcome = result.outcome
        current = self.db.get_work_item_row(item.identifier)
        if current is not None and current.state == "cancel_requested":
            outcome = "cancelled"
        if item.identifier in self._cancelled:
            outcome = "cancelled"
        if outcome == "completed":
            self.db.finish_attempt_with_fencing(
                attempt_id=bundle.attempt.attempt_id,
                lease_id=bundle.lease.lease_id,
                fencing_token=bundle.lease.fencing_token,
                attempt_state="succeeded",
                work_item_state="succeeded",
                exit_reason="completed",
                omp_session_file=result.session_file,
            )
            return
        if outcome == "blocked":
            self.db.finish_attempt_with_fencing(
                attempt_id=bundle.attempt.attempt_id,
                lease_id=bundle.lease.lease_id,
                fencing_token=bundle.lease.fencing_token,
                attempt_state="blocked",
                work_item_state="blocked",
                exit_reason="blocked",
                error=result.error,
                blocked_reason=result.blocked_reason,
                omp_session_file=result.session_file,
            )
            return
        if outcome == "cancelled":
            self.db.finish_attempt_with_fencing(
                attempt_id=bundle.attempt.attempt_id,
                lease_id=bundle.lease.lease_id,
                fencing_token=bundle.lease.fencing_token,
                attempt_state="cancelled",
                work_item_state="cancelled",
                exit_reason="cancelled",
                error=result.error,
                omp_session_file=result.session_file,
            )
            return
        self.db.finish_attempt_with_fencing(
            attempt_id=bundle.attempt.attempt_id,
            lease_id=bundle.lease.lease_id,
            fencing_token=bundle.lease.fencing_token,
            attempt_state="failed",
            work_item_state="failed",
            exit_reason="failed",
            error=result.error,
            omp_session_file=result.session_file,
        )


class ConductorClient:
    """Small synchronous HTTP client for pull workers and remote state sinks."""

    def __init__(self, *, base_url: str, api_token: str | None, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token
        self.timeout_seconds = timeout_seconds

    def register_worker(
        self,
        *,
        worker_id: str,
        host: str,
        labels: Iterable[str],
        capacity: int,
        state: WorkerState = "online",
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/api/v1/workers/register",
            {
                "worker_id": worker_id,
                "host": host,
                "labels": list(labels),
                "capacity": capacity,
                "state": state,
            },
        )

    def heartbeat_worker(
        self,
        *,
        worker_id: str,
        state: WorkerState,
        running_count: int,
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            f"/api/v1/workers/{worker_id}/heartbeat",
            {"state": state, "running_count": running_count},
        )

    def claim_lease(
        self,
        *,
        worker_id: str,
        worker_labels: Iterable[str],
        workspace_root: str,
    ) -> ClaimedAttempt | None:
        payload = self._request_json(
            "POST",
            "/api/v1/leases/claim",
            {
                "worker_id": worker_id,
                "worker_labels": list(worker_labels),
                "workspace_root": workspace_root,
            },
        )
        if not payload.get("claimed", False):
            return None
        work_item = payload["work_item"]
        attempt = payload["attempt"]
        lease = payload["lease"]
        return ClaimedAttempt(
            work_item_id=int(work_item["id"]),
            identifier=str(work_item["identifier"]),
            title=str(work_item["title"]),
            body=str(work_item["body"]),
            repo_path=work_item.get("repo_path"),
            labels=tuple(str(item) for item in work_item.get("labels", [])),
            attempt_id=str(attempt["attempt_id"]),
            attempt_no=int(attempt["attempt_no"]),
            lease_id=str(lease["lease_id"]),
            fencing_token=str(lease["fencing_token"]),
            workspace_path=str(attempt["workspace_path"]),
            session_dir=str(attempt["session_dir"]),
        )

    def renew_lease(self, *, lease_id: str, fencing_token: str, ttl_seconds: float) -> dict[str, Any]:
        return self._request_json(
            "POST",
            f"/api/v1/leases/{lease_id}/renew",
            {"fencing_token": fencing_token, "ttl_seconds": ttl_seconds},
        )

    def finish_lease(
        self,
        *,
        lease_id: str,
        attempt_id: str,
        fencing_token: str,
        attempt_state: str,
        work_item_state: str,
        exit_reason: str | None,
        error: str | None,
        blocked_reason: str | None,
        omp_session_file: str | None,
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            f"/api/v1/leases/{lease_id}/finish",
            {
                "attempt_id": attempt_id,
                "fencing_token": fencing_token,
                "attempt_state": attempt_state,
                "work_item_state": work_item_state,
                "exit_reason": exit_reason,
                "error": error,
                "blocked_reason": blocked_reason,
                "omp_session_file": omp_session_file,
            },
        )

    def append_event(
        self,
        *,
        event_type: str,
        payload: dict[str, Any],
        work_item_id: int | None,
        attempt_id: str | None,
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/api/v1/events",
            {
                "event_type": event_type,
                "payload": payload,
                "work_item_id": work_item_id,
                "attempt_id": attempt_id,
            },
        )

    def _request_json(self, method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_token}"} if self.api_token else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                data = response.read()
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"conductor request failed: {exc.code} {exc.reason}") from exc
        if not data:
            return {}
        return json.loads(data.decode("utf-8"))


class RemoteStateSink(AttemptStateSink):
    def __init__(self, conductor: ConductorClient, *, work_item_id: int, attempt_id: str, identifier: str) -> None:
        self._conductor = conductor
        self._work_item_id = work_item_id
        self._attempt_id = attempt_id
        self._identifier = identifier

    def touch_attempt(
        self,
        attempt_id: str,
        *,
        state: str | None = None,
        last_event_at: str | None = None,
        error: str | None = None,
        exit_reason: str | None = None,
        omp_session_file: str | None = None,
    ) -> None:
        return None

    def mark_blocked(
        self,
        *,
        identifier: str,
        reason: str,
        retry_due_at: str | None = None,
    ) -> None:
        self.append_event(
            event_type="work_item_blocked",
            payload={"identifier": identifier, "reason": reason, "retry_due_at": retry_due_at},
            work_item_id=self._work_item_id,
            attempt_id=self._attempt_id,
        )

    def append_event(
        self,
        *,
        event_type: str,
        payload: dict[str, Any],
        work_item_id: int | None = None,
        attempt_id: str | None = None,
    ) -> None:
        self._conductor.append_event(
            event_type=event_type,
            payload=payload,
            work_item_id=work_item_id,
            attempt_id=attempt_id,
        )


class PullWorker:
    """Remote worker that polls a central conductor over HTTP."""

    def __init__(
        self,
        *,
        settings: Settings,
        conductor: ConductorClient,
        workspace_manager: WorkspaceManager,
        workflow_store: WorkflowStore,
        runner_factory: Callable[[AttemptStateSink], OmpAttemptRunner] = OmpAttemptRunner,
    ) -> None:
        self.settings = settings
        self.conductor = conductor
        self.workspace_manager = workspace_manager
        self.workflow_store = workflow_store
        self._runner_factory = runner_factory
        self.worker_id = settings.worker_id or f"pull-{socket.gethostname()}"
        self.worker_labels = settings.worker_labels
        self.capacity = settings.max_concurrency
        self._workers: list[asyncio.Task[None]] = []
        self._wakeup = asyncio.Event()
        self._stop = asyncio.Event()
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._cancel_hooks: dict[str, Callable[[], None]] = {}
        self._inflight_tasks: dict[asyncio.Task[None], str] = {}
        self._shutting_down = False

    async def start(self) -> None:
        self._validate_remote_auth_requirements()
        await asyncio.to_thread(
            self.conductor.register_worker,
            worker_id=self.worker_id,
            host=socket.gethostname(),
            labels=self.worker_labels,
            capacity=self.capacity,
            state="online",
        )
        self._workers.append(asyncio.create_task(self._dispatch_loop(), name="liaogong-pull-dispatch"))
        self._workers.append(asyncio.create_task(self._heartbeat_loop(), name="liaogong-pull-heartbeat"))

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        self._shutting_down = True
        self._stop.set()
        self._wakeup.set()
        for task in self._workers:
            task.cancel()
        for task in self._workers:
            with suppress(asyncio.CancelledError):
                await task
        self._workers.clear()
        pending = list(self._inflight_tasks)
        _, still_running = await asyncio.wait(pending, timeout=drain_timeout)
        for task in still_running:
            identifier = self._inflight_tasks.get(task)
            hook = self._cancel_hooks.pop(identifier or "", None)
            if hook is not None:
                await asyncio.to_thread(hook)
            else:
                task.cancel()
        with suppress(TimeoutError):
            await asyncio.wait(still_running, timeout=kill_timeout)
        await asyncio.to_thread(
            self.conductor.heartbeat_worker,
            worker_id=self.worker_id,
            state="offline",
            running_count=0,
        )

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.to_thread(
                self.conductor.heartbeat_worker,
                worker_id=self.worker_id,
                state="draining" if self._shutting_down else "online",
                running_count=len(self._inflight_tasks),
            )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.settings.heartbeat_interval_seconds)
            except TimeoutError:
                pass

    async def _dispatch_loop(self) -> None:
        while not self._stop.is_set():
            await self._semaphore.acquire()
            claim = await asyncio.to_thread(
                self.conductor.claim_lease,
                worker_id=self.worker_id,
                worker_labels=self.worker_labels,
                workspace_root=str(self.workspace_manager.workspace_root),
            )
            if claim is None:
                self._semaphore.release()
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=10.0)
                except TimeoutError:
                    pass
                continue
            task = asyncio.create_task(self._run_claimed_attempt(claim), name=f"liaogong-remote-{claim.identifier}")
            self._inflight_tasks[task] = claim.identifier
            task.add_done_callback(self._attempt_done)

    def _attempt_done(self, task: asyncio.Task[None]) -> None:
        self._inflight_tasks.pop(task, None)
        self._semaphore.release()

    async def _run_claimed_attempt(self, claim: ClaimedAttempt) -> None:
        hooks = self.workflow_store.load().hooks
        try:
            layout = self.workspace_manager.allocate(claim.identifier)
            if str(layout.repo_path) != claim.workspace_path or str(layout.session_dir) != claim.session_dir:
                raise WorkspaceError("remote claim workspace paths do not match local workspace policy")
            await self.workspace_manager.run_after_create(layout, hooks)
            rendered = self.workflow_store.render_prompt(
                identifier=claim.identifier,
                title=claim.title,
                body=claim.body,
                workspace_path=layout.workspace_path,
                session_dir=layout.session_dir,
                attempt_no=claim.attempt_no,
                repo_path=Path(claim.repo_path) if claim.repo_path is not None else layout.repo_path,
            )
            if rendered.blocked:
                await asyncio.to_thread(
                    self.conductor.finish_lease,
                    lease_id=claim.lease_id,
                    attempt_id=claim.attempt_id,
                    fencing_token=claim.fencing_token,
                    attempt_state="blocked",
                    work_item_state="blocked",
                    exit_reason="blocked",
                    error=rendered.blocked_details,
                    blocked_reason=rendered.blocked_reason,
                    omp_session_file=None,
                )
                return
            await self.workspace_manager.run_before_run(layout, hooks)
            sink = RemoteStateSink(
                self.conductor,
                work_item_id=claim.work_item_id,
                attempt_id=claim.attempt_id,
                identifier=claim.identifier,
            )
            runner = self._runner_factory(sink)
            cancel_runner = getattr(runner, "cancel", lambda: None)
            renew_task = asyncio.create_task(self._renew_remote(claim, cancel_runner))
            try:
                result = await asyncio.to_thread(
                    lambda: runner.run(
                        OmpRunRequest(
                            attempt_id=claim.attempt_id,
                            work_item_id=claim.work_item_id,
                            identifier=claim.identifier,
                            prompt="Please execute the current work item.",
                            cwd=layout.repo_path,
                            session_dir=layout.session_dir,
                            omp_command=self.settings.omp_command,
                            request_timeout=self.settings.request_timeout_seconds,
                            task_timeout=self.settings.task_timeout_seconds,
                            attempt_no=claim.attempt_no,
                            append_system_prompt=rendered.prompt,
                        ),
                        on_cancel_ready=lambda hook: self._cancel_hooks.__setitem__(claim.identifier, hook),
                    )
                )
            finally:
                renew_task.cancel()
                with suppress(asyncio.CancelledError):
                    await renew_task
                self._cancel_hooks.pop(claim.identifier, None)
                await self.workspace_manager.run_after_run(layout, hooks)
            await asyncio.to_thread(self._finalize_remote_result, claim, result)
        except Exception as exc:
            log.exception("pull worker attempt failed", extra={"identifier": claim.identifier})
            await asyncio.to_thread(
                self.conductor.finish_lease,
                lease_id=claim.lease_id,
                attempt_id=claim.attempt_id,
                fencing_token=claim.fencing_token,
                attempt_state="failed",
                work_item_state="failed",
                exit_reason="failed",
                error=str(exc),
                blocked_reason=None,
                omp_session_file=None,
            )

    async def _renew_remote(self, claim: ClaimedAttempt, cancel_runner: Callable[[], None]) -> None:
        try:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.settings.heartbeat_interval_seconds)
                    return
                except TimeoutError:
                    pass
                try:
                    await asyncio.to_thread(
                        self.conductor.renew_lease,
                        lease_id=claim.lease_id,
                        fencing_token=claim.fencing_token,
                        ttl_seconds=self.settings.lease_ttl_seconds,
                    )
                except Exception:
                    log.exception("remote lease renew failed", extra={"identifier": claim.identifier})
                    await asyncio.to_thread(cancel_runner)
                    return
        except asyncio.CancelledError:
            raise

    def _finalize_remote_result(self, claim: ClaimedAttempt, result: OmpRunResult) -> None:
        if result.outcome == "completed":
            attempt_state, work_item_state = "succeeded", "succeeded"
        elif result.outcome == "blocked":
            attempt_state, work_item_state = "blocked", "blocked"
        elif result.outcome == "cancelled":
            attempt_state, work_item_state = "cancelled", "cancelled"
        else:
            attempt_state, work_item_state = "failed", "failed"
        self.conductor.finish_lease(
            lease_id=claim.lease_id,
            attempt_id=claim.attempt_id,
            fencing_token=claim.fencing_token,
            attempt_state=attempt_state,
            work_item_state=work_item_state,
            exit_reason=result.outcome,
            error=result.error,
            blocked_reason=result.blocked_reason,
            omp_session_file=result.session_file,
        )

    def _validate_remote_auth_requirements(self) -> None:
        if not self.settings.remote_required_broker:
            return
        if not os.environ.get("OMP_AUTH_BROKER_URL") or not os.environ.get("OMP_AUTH_BROKER_TOKEN"):
            raise RuntimeError(
                "remote worker requires OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN when remote_required_broker=true"
            )


__all__ = ["ClaimedAttempt", "ConductorClient", "PullWorker", "RemoteStateSink", "WorkerPool"]
