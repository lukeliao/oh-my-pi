"""SQLite-backed durable state for liaogong-symphony."""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

WorkItemState = Literal[
    "queued",
    "leased",
    "running",
    "blocked",
    "retry_scheduled",
    "succeeded",
    "failed",
    "cancel_requested",
    "cancelled",
    "stale",
    "terminal",
]

LeaseState = Literal["active", "released", "expired", "cancelled"]
WorkerState = Literal["online", "draining", "offline"]
AttemptState = Literal[
    "preparing",
    "launching",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "stalled",
    "cancelled",
    "stale",
    "blocked",
]

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier     TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  source_kind    TEXT NOT NULL CHECK(source_kind IN ('manual')),
  repo_path      TEXT,
  labels_json    TEXT NOT NULL DEFAULT '[]',
  priority       INTEGER NOT NULL DEFAULT 100,
  state          TEXT NOT NULL CHECK(state IN (
                    'queued','leased','running','blocked','retry_scheduled',
                    'succeeded','failed','cancel_requested','cancelled','stale','terminal')),
  retry_due_at   TEXT,
  blocked_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_items_state_priority_created
  ON work_items(state, priority, created_at);
CREATE INDEX IF NOT EXISTS work_items_retry_due
  ON work_items(state, retry_due_at);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id        TEXT PRIMARY KEY,
  work_item_id      INTEGER NOT NULL,
  attempt_no        INTEGER NOT NULL,
  worker_id         TEXT,
  lease_id          TEXT,
  workspace_path    TEXT,
  session_dir       TEXT,
  omp_session_file  TEXT,
  state             TEXT NOT NULL CHECK(state IN (
                       'preparing','launching','running','succeeded','failed',
                       'timed_out','stalled','cancelled','stale','blocked')),
  started_at        TEXT,
  ended_at          TEXT,
  last_event_at     TEXT,
  exit_reason       TEXT,
  error             TEXT,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  UNIQUE(work_item_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS attempts_work_item_started
  ON attempts(work_item_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS attempts_worker_state
  ON attempts(worker_id, state);

CREATE TABLE IF NOT EXISTS leases (
  lease_id         TEXT PRIMARY KEY,
  work_item_id     INTEGER NOT NULL,
  attempt_id       TEXT NOT NULL,
  worker_id        TEXT NOT NULL,
  fencing_token    TEXT NOT NULL,
  state            TEXT NOT NULL CHECK(state IN ('active','released','expired','cancelled')),
  acquired_at      TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  UNIQUE(attempt_id)
);
CREATE INDEX IF NOT EXISTS leases_work_item_state
  ON leases(work_item_id, state, expires_at);
CREATE INDEX IF NOT EXISTS leases_worker_state
  ON leases(worker_id, state, expires_at);

CREATE TABLE IF NOT EXISTS workers (
  worker_id        TEXT PRIMARY KEY,
  host             TEXT NOT NULL,
  labels_json      TEXT NOT NULL,
  capacity         INTEGER NOT NULL,
  running_count    INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL CHECK(state IN ('online','draining','offline')),
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workers_state_last_seen
  ON workers(state, last_seen_at);

CREATE TABLE IF NOT EXISTS workspace_refs (
  workspace_key    TEXT NOT NULL,
  worker_id        TEXT NOT NULL,
  workspace_path   TEXT NOT NULL,
  session_dir      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT NOT NULL,
  UNIQUE(workspace_key, worker_id)
);
CREATE INDEX IF NOT EXISTS workspace_refs_worker
  ON workspace_refs(worker_id, last_used_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id     INTEGER,
  attempt_id       TEXT,
  event_type       TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  ts               TEXT NOT NULL,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS events_work_item_ts
  ON events(work_item_id, id DESC);
CREATE INDEX IF NOT EXISTS events_attempt_ts
  ON events(attempt_id, id DESC);
"""

_TERMINAL_WORK_ITEM_STATES: tuple[WorkItemState, ...] = (
    "succeeded",
    "failed",
    "cancelled",
    "terminal",
)
_CLAIMABLE_WORK_ITEM_STATES: tuple[WorkItemState, ...] = ("queued", "retry_scheduled")
_RUNNING_ATTEMPT_STATES: tuple[AttemptState, ...] = ("preparing", "launching", "running")


class StaleLeaseError(RuntimeError):
    """Raised when a finalize/renew call no longer owns the active lease."""


@dataclass(slots=True, frozen=True)
class WorkItemRow:
    id: int
    identifier: str
    title: str
    body: str
    source_kind: str
    repo_path: str | None
    labels: tuple[str, ...]
    priority: int
    state: WorkItemState
    retry_due_at: str | None
    blocked_reason: str | None
    created_at: str
    updated_at: str


@dataclass(slots=True, frozen=True)
class AttemptRow:
    attempt_id: str
    work_item_id: int
    attempt_no: int
    worker_id: str | None
    lease_id: str | None
    workspace_path: str | None
    session_dir: str | None
    omp_session_file: str | None
    state: AttemptState
    started_at: str | None
    ended_at: str | None
    last_event_at: str | None
    exit_reason: str | None
    error: str | None


@dataclass(slots=True, frozen=True)
class LeaseRow:
    lease_id: str
    work_item_id: int
    attempt_id: str
    worker_id: str
    fencing_token: str
    state: LeaseState
    acquired_at: str
    heartbeat_at: str
    expires_at: str


@dataclass(slots=True, frozen=True)
class WorkerRow:
    worker_id: str
    host: str
    labels: tuple[str, ...]
    capacity: int
    running_count: int
    state: WorkerState
    last_seen_at: str


@dataclass(slots=True, frozen=True)
class WorkspaceRefRow:
    workspace_key: str
    worker_id: str
    workspace_path: str
    session_dir: str
    created_at: str
    last_used_at: str


@dataclass(slots=True, frozen=True)
class EventRow:
    id: int
    work_item_id: int | None
    attempt_id: str | None
    event_type: str
    payload: dict[str, Any]
    ts: str


@dataclass(slots=True, frozen=True)
class EnqueueResult:
    accepted: bool
    duplicate: bool
    work_item: WorkItemRow


@dataclass(slots=True, frozen=True)
class AttemptLeaseBundle:
    work_item: WorkItemRow
    attempt: AttemptRow
    lease: LeaseRow


@dataclass(slots=True, frozen=True)
class WorkItemRecord:
    work_item: WorkItemRow
    attempts: tuple[AttemptRow, ...]
    active_lease: LeaseRow | None
    last_event: EventRow | None

    @property
    def latest_attempt(self) -> AttemptRow | None:
        return self.attempts[0] if self.attempts else None


@dataclass(slots=True, frozen=True)
class FinishResult:
    work_item: WorkItemRow
    attempt: AttemptRow
    lease: LeaseRow


def _utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _iso_after(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _json_dumps(payload: Mapping[str, Any] | Iterable[str] | dict[str, Any] | list[str]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _json_loads_labels(payload: str) -> tuple[str, ...]:
    loaded = json.loads(payload)
    if not isinstance(loaded, list):
        return ()
    return tuple(str(item) for item in loaded)


def _work_item_from_row(row: sqlite3.Row) -> WorkItemRow:
    return WorkItemRow(
        id=int(row["id"]),
        identifier=row["identifier"],
        title=row["title"],
        body=row["body"],
        source_kind=row["source_kind"],
        repo_path=row["repo_path"],
        labels=_json_loads_labels(row["labels_json"]),
        priority=int(row["priority"]),
        state=row["state"],
        retry_due_at=row["retry_due_at"],
        blocked_reason=row["blocked_reason"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _attempt_from_row(row: sqlite3.Row) -> AttemptRow:
    return AttemptRow(
        attempt_id=row["attempt_id"],
        work_item_id=int(row["work_item_id"]),
        attempt_no=int(row["attempt_no"]),
        worker_id=row["worker_id"],
        lease_id=row["lease_id"],
        workspace_path=row["workspace_path"],
        session_dir=row["session_dir"],
        omp_session_file=row["omp_session_file"],
        state=row["state"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        last_event_at=row["last_event_at"],
        exit_reason=row["exit_reason"],
        error=row["error"],
    )


def _lease_from_row(row: sqlite3.Row) -> LeaseRow:
    return LeaseRow(
        lease_id=row["lease_id"],
        work_item_id=int(row["work_item_id"]),
        attempt_id=row["attempt_id"],
        worker_id=row["worker_id"],
        fencing_token=row["fencing_token"],
        state=row["state"],
        acquired_at=row["acquired_at"],
        heartbeat_at=row["heartbeat_at"],
        expires_at=row["expires_at"],
    )


def _worker_from_row(row: sqlite3.Row) -> WorkerRow:
    return WorkerRow(
        worker_id=row["worker_id"],
        host=row["host"],
        labels=_json_loads_labels(row["labels_json"]),
        capacity=int(row["capacity"]),
        running_count=int(row["running_count"]),
        state=row["state"],
        last_seen_at=row["last_seen_at"],
    )


def _workspace_ref_from_row(row: sqlite3.Row) -> WorkspaceRefRow:
    return WorkspaceRefRow(
        workspace_key=row["workspace_key"],
        worker_id=row["worker_id"],
        workspace_path=row["workspace_path"],
        session_dir=row["session_dir"],
        created_at=row["created_at"],
        last_used_at=row["last_used_at"],
    )


def _event_from_row(row: sqlite3.Row) -> EventRow:
    return EventRow(
        id=int(row["id"]),
        work_item_id=int(row["work_item_id"]) if row["work_item_id"] is not None else None,
        attempt_id=row["attempt_id"],
        event_type=row["event_type"],
        payload=json.loads(row["payload_json"]),
        ts=row["ts"],
    )


def _labels_match(item_labels: tuple[str, ...], worker_labels: tuple[str, ...]) -> bool:
    if not item_labels:
        return True
    if not worker_labels:
        return False
    worker_label_set = set(worker_labels)
    return any(label in worker_label_set for label in item_labels)


class Database:
    """Thread-safe SQLite wrapper with explicit lease/fencing transitions."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _migrate(self) -> None:
        attempt_cols = {row[1] for row in self._conn.execute("PRAGMA table_info(attempts)").fetchall()}
        if "omp_session_file" not in attempt_cols:
            self._conn.execute("ALTER TABLE attempts ADD COLUMN omp_session_file TEXT")
        work_item_cols = {row[1] for row in self._conn.execute("PRAGMA table_info(work_items)").fetchall()}
        if "blocked_reason" not in work_item_cols:
            self._conn.execute("ALTER TABLE work_items ADD COLUMN blocked_reason TEXT")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def enqueue_manual_work_item(
        self,
        *,
        identifier: str,
        title: str,
        body: str,
        repo_path: str | None = None,
        labels: Iterable[str] = (),
        priority: int = 100,
    ) -> EnqueueResult:
        now = _utcnow()
        labels_json = _json_dumps([str(label) for label in labels])
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO work_items
                  (identifier, title, body, source_kind, repo_path, labels_json, priority,
                   state, retry_due_at, blocked_reason, created_at, updated_at)
                VALUES (?, ?, ?, 'manual', ?, ?, ?, 'queued', NULL, NULL, ?, ?)
                """,
                (identifier, title, body, repo_path, labels_json, int(priority), now, now),
            )
        row = self.get_work_item_row(identifier)
        assert row is not None
        return EnqueueResult(accepted=cur.rowcount > 0, duplicate=cur.rowcount == 0, work_item=row)

    def claim_next_work_item(
        self,
        *,
        worker_labels: Iterable[str] = (),
        limit_scan: int = 64,
    ) -> WorkItemRow | None:
        now = _utcnow()
        labels = tuple(str(label) for label in worker_labels)
        with self._txn() as conn:
            rows = conn.execute(
                """
                SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                       state, retry_due_at, blocked_reason, created_at, updated_at
                FROM work_items
                WHERE state = 'queued'
                   OR (state = 'retry_scheduled' AND (retry_due_at IS NULL OR retry_due_at <= ?))
                ORDER BY priority ASC,
                         CASE WHEN retry_due_at IS NULL THEN created_at ELSE retry_due_at END ASC,
                         created_at ASC
                LIMIT ?
                """,
                (now, int(limit_scan)),
            ).fetchall()
            for row in rows:
                item = _work_item_from_row(row)
                if not _labels_match(item.labels, labels):
                    continue
                updated = conn.execute(
                    "UPDATE work_items SET state='leased', updated_at=? WHERE id=? AND state=?",
                    (now, item.id, item.state),
                )
                if updated.rowcount != 1:
                    continue
                refreshed = conn.execute(
                    """
                    SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                           state, retry_due_at, blocked_reason, created_at, updated_at
                    FROM work_items WHERE id = ?
                    """,
                    (item.id,),
                ).fetchone()
                assert refreshed is not None
                return _work_item_from_row(refreshed)
        return None

    def create_attempt_and_lease(
        self,
        *,
        work_item_id: int,
        worker_id: str,
        workspace_path: str,
        session_dir: str,
        lease_ttl_seconds: float,
        attempt_state: AttemptState = "preparing",
    ) -> AttemptLeaseBundle:
        attempt_id = str(uuid4())
        lease_id = str(uuid4())
        fencing_token = secrets.token_hex(16)
        now = _utcnow()
        expires_at = _iso_after(lease_ttl_seconds)
        with self._txn() as conn:
            row = conn.execute(
                """
                SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                       state, retry_due_at, blocked_reason, created_at, updated_at
                FROM work_items WHERE id = ?
                """,
                (work_item_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"unknown work item id: {work_item_id}")
            item = _work_item_from_row(row)
            active_lease_count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM leases WHERE work_item_id = ? AND state = 'active'",
                    (work_item_id,),
                ).fetchone()[0]
            )
            if active_lease_count > 0:
                raise RuntimeError(f"work item {item.identifier} already has an active lease")
            if item.state not in ("leased", "running"):
                raise RuntimeError(f"work item {item.identifier} not leasable from state {item.state}")
            attempt_no = int(
                conn.execute(
                    "SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM attempts WHERE work_item_id = ?",
                    (work_item_id,),
                ).fetchone()[0]
            )
            conn.execute(
                """
                INSERT INTO attempts
                  (attempt_id, work_item_id, attempt_no, worker_id, lease_id, workspace_path,
                   session_dir, omp_session_file, state, started_at, ended_at, last_event_at,
                   exit_reason, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL)
                """,
                (
                    attempt_id,
                    work_item_id,
                    attempt_no,
                    worker_id,
                    lease_id,
                    workspace_path,
                    session_dir,
                    attempt_state,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO leases
                  (lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                   acquired_at, heartbeat_at, expires_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
                """,
                (lease_id, work_item_id, attempt_id, worker_id, fencing_token, now, now, expires_at),
            )
            conn.execute(
                "UPDATE work_items SET state='running', blocked_reason=NULL, updated_at=? WHERE id=?",
                (now, work_item_id),
            )
            conn.execute(
                "UPDATE workers SET running_count = running_count + 1, last_seen_at=? WHERE worker_id=?",
                (now, worker_id),
            )
        return AttemptLeaseBundle(
            work_item=self.get_work_item_row_by_id(work_item_id),
            attempt=self.get_attempt(attempt_id),
            lease=self.get_lease(lease_id),
        )

    def renew_lease(self, *, lease_id: str, fencing_token: str, ttl_seconds: float) -> LeaseRow:
        now = _utcnow()
        expires_at = _iso_after(ttl_seconds)
        with self._txn() as conn:
            row = conn.execute(
                "SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state, acquired_at, heartbeat_at, expires_at FROM leases WHERE lease_id = ?",
                (lease_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"unknown lease: {lease_id}")
            lease = _lease_from_row(row)
            if lease.fencing_token != fencing_token or lease.state != "active":
                raise StaleLeaseError(f"lease {lease_id} no longer owns the active token")
            conn.execute(
                "UPDATE leases SET heartbeat_at=?, expires_at=? WHERE lease_id=?",
                (now, expires_at, lease_id),
            )
            conn.execute(
                "UPDATE workers SET last_seen_at=? WHERE worker_id=?",
                (now, lease.worker_id),
            )
        return self.get_lease(lease_id)

    def touch_attempt(
        self,
        attempt_id: str,
        *,
        state: AttemptState | None = None,
        last_event_at: str | None = None,
        error: str | None = None,
        exit_reason: str | None = None,
        omp_session_file: str | None = None,
    ) -> AttemptRow | None:
        try:
            existing = self.get_attempt(attempt_id)
        except KeyError:
            return None
        values = {
            "state": state or existing.state,
            "last_event_at": last_event_at or _utcnow(),
            "error": error if error is not None else existing.error,
            "exit_reason": exit_reason if exit_reason is not None else existing.exit_reason,
            "omp_session_file": omp_session_file if omp_session_file is not None else existing.omp_session_file,
        }
        with self._lock:
            self._conn.execute(
                """
                UPDATE attempts
                SET state=?, last_event_at=?, error=?, exit_reason=?, omp_session_file=?
                WHERE attempt_id=?
                """,
                (
                    values["state"],
                    values["last_event_at"],
                    values["error"],
                    values["exit_reason"],
                    values["omp_session_file"],
                    attempt_id,
                ),
            )
        return self.get_attempt(attempt_id)

    def finish_attempt_with_fencing(
        self,
        *,
        attempt_id: str,
        lease_id: str,
        fencing_token: str,
        attempt_state: AttemptState,
        work_item_state: WorkItemState,
        exit_reason: str | None = None,
        error: str | None = None,
        retry_due_at: str | None = None,
        blocked_reason: str | None = None,
        omp_session_file: str | None = None,
    ) -> FinishResult:
        now = _utcnow()
        with self._txn() as conn:
            attempt_row = conn.execute(
                """
                SELECT attempt_id, work_item_id, attempt_no, worker_id, lease_id, workspace_path,
                       session_dir, omp_session_file, state, started_at, ended_at, last_event_at,
                       exit_reason, error
                FROM attempts WHERE attempt_id = ?
                """,
                (attempt_id,),
            ).fetchone()
            if attempt_row is None:
                raise KeyError(f"unknown attempt: {attempt_id}")
            attempt = _attempt_from_row(attempt_row)
            lease_row = conn.execute(
                """
                SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                       acquired_at, heartbeat_at, expires_at
                FROM leases WHERE lease_id = ?
                """,
                (lease_id,),
            ).fetchone()
            if lease_row is None:
                raise KeyError(f"unknown lease: {lease_id}")
            active_row = conn.execute(
                """
                SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                       acquired_at, heartbeat_at, expires_at
                FROM leases
                WHERE work_item_id = ? AND state = 'active'
                ORDER BY acquired_at DESC
                LIMIT 1
                """,
                (attempt.work_item_id,),
            ).fetchone()
            if active_row is None:
                raise StaleLeaseError(f"work item {attempt.work_item_id} has no active lease")
            active = _lease_from_row(active_row)
            if active.lease_id != lease_id or active.fencing_token != fencing_token:
                raise StaleLeaseError(f"lease {lease_id} no longer owns work item {attempt.work_item_id}")
            lease_state: LeaseState = "cancelled" if attempt_state == "cancelled" else "released"
            conn.execute(
                """
                UPDATE attempts
                SET state=?, ended_at=?, last_event_at=?, exit_reason=?, error=?, omp_session_file=?
                WHERE attempt_id=?
                """,
                (
                    attempt_state,
                    now,
                    now,
                    exit_reason,
                    error,
                    omp_session_file if omp_session_file is not None else attempt.omp_session_file,
                    attempt_id,
                ),
            )
            conn.execute(
                "UPDATE leases SET state=?, heartbeat_at=?, expires_at=? WHERE lease_id=?",
                (lease_state, now, now, lease_id),
            )
            conn.execute(
                """
                UPDATE work_items
                SET state=?, retry_due_at=?, blocked_reason=?, updated_at=?
                WHERE id=?
                """,
                (work_item_state, retry_due_at, blocked_reason, now, attempt.work_item_id),
            )
            if attempt.worker_id is not None:
                conn.execute(
                    """
                    UPDATE workers
                    SET running_count = CASE WHEN running_count > 0 THEN running_count - 1 ELSE 0 END,
                        last_seen_at=?
                    WHERE worker_id=?
                    """,
                    (now, attempt.worker_id),
                )
        return FinishResult(
            work_item=self.get_work_item_row_by_id(attempt.work_item_id),
            attempt=self.get_attempt(attempt_id),
            lease=self.get_lease(lease_id),
        )

    def mark_blocked(
        self,
        *,
        identifier: str,
        reason: str,
        retry_due_at: str | None = None,
    ) -> WorkItemRow | None:
        now = _utcnow()
        with self._lock:
            self._conn.execute(
                """
                UPDATE work_items
                SET state='blocked', blocked_reason=?, retry_due_at=?, updated_at=?
                WHERE identifier=? AND state NOT IN ('succeeded','failed','cancelled','terminal')
                """,
                (reason, retry_due_at, now, identifier),
            )
        return self.get_work_item_row(identifier)

    def schedule_retry(
        self,
        *,
        identifier: str,
        retry_due_at: str,
        error: str | None = None,
    ) -> WorkItemRow | None:
        now = _utcnow()
        with self._lock:
            self._conn.execute(
                """
                UPDATE work_items
                SET state='retry_scheduled', retry_due_at=?, blocked_reason=?, updated_at=?
                WHERE identifier=? AND state NOT IN ('succeeded','terminal')
                """,
                (retry_due_at, error, now, identifier),
            )
        return self.get_work_item_row(identifier)

    def request_cancel(self, identifier: str) -> WorkItemRow | None:
        row = self.get_work_item_row(identifier)
        if row is None:
            return None
        now = _utcnow()
        if row.state in _TERMINAL_WORK_ITEM_STATES:
            return row
        next_state: WorkItemState = "cancel_requested"
        if row.state in ("queued", "retry_scheduled", "blocked", "stale"):
            next_state = "cancelled"
        with self._lock:
            self._conn.execute(
                "UPDATE work_items SET state=?, updated_at=? WHERE id=?",
                (next_state, now, row.id),
            )
        return self.get_work_item_row(identifier)

    def register_worker(
        self,
        *,
        worker_id: str,
        host: str,
        labels: Iterable[str],
        capacity: int,
        state: WorkerState = "online",
    ) -> WorkerRow:
        now = _utcnow()
        labels_json = _json_dumps([str(label) for label in labels])
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO workers(worker_id, host, labels_json, capacity, running_count, state, last_seen_at)
                VALUES (?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(worker_id) DO UPDATE SET
                  host=excluded.host,
                  labels_json=excluded.labels_json,
                  capacity=excluded.capacity,
                  state=excluded.state,
                  last_seen_at=excluded.last_seen_at
                """,
                (worker_id, host, labels_json, int(capacity), state, now),
            )
        return self.get_worker(worker_id)

    def heartbeat_worker(
        self,
        *,
        worker_id: str,
        state: WorkerState | None = None,
        running_count: int | None = None,
    ) -> WorkerRow | None:
        now = _utcnow()
        row = self.get_worker(worker_id)
        if row is None:
            return None
        next_state = state or row.state
        next_running_count = row.running_count if running_count is None else max(0, int(running_count))
        with self._lock:
            self._conn.execute(
                "UPDATE workers SET state=?, running_count=?, last_seen_at=? WHERE worker_id=?",
                (next_state, next_running_count, now, worker_id),
            )
        return self.get_worker(worker_id)

    def upsert_workspace_ref(
        self,
        *,
        workspace_key: str,
        worker_id: str,
        workspace_path: str,
        session_dir: str,
    ) -> WorkspaceRefRow:
        now = _utcnow()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO workspace_refs
                  (workspace_key, worker_id, workspace_path, session_dir, created_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(workspace_key, worker_id) DO UPDATE SET
                  workspace_path=excluded.workspace_path,
                  session_dir=excluded.session_dir,
                  last_used_at=excluded.last_used_at
                """,
                (workspace_key, worker_id, workspace_path, session_dir, now, now),
            )
        return self.get_workspace_ref(workspace_key, worker_id)

    def append_event(
        self,
        *,
        event_type: str,
        payload: Mapping[str, Any],
        work_item_id: int | None = None,
        attempt_id: str | None = None,
    ) -> EventRow:
        now = _utcnow()
        with self._txn() as conn:
            cur = conn.execute(
                "INSERT INTO events(work_item_id, attempt_id, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?)",
                (work_item_id, attempt_id, event_type, _json_dumps(dict(payload)), now),
            )
            if attempt_id is not None:
                conn.execute(
                    "UPDATE attempts SET last_event_at=? WHERE attempt_id=?",
                    (now, attempt_id),
                )
            event_id = int(cur.lastrowid)
        row = self._conn.execute(
            "SELECT id, work_item_id, attempt_id, event_type, payload_json, ts FROM events WHERE id=?",
            (event_id,),
        ).fetchone()
        assert row is not None
        return _event_from_row(row)

    def get_work_item_row(self, identifier: str) -> WorkItemRow | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                       state, retry_due_at, blocked_reason, created_at, updated_at
                FROM work_items WHERE identifier = ?
                """,
                (identifier,),
            ).fetchone()
        return _work_item_from_row(row) if row is not None else None

    def get_work_item_row_by_id(self, work_item_id: int) -> WorkItemRow:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                       state, retry_due_at, blocked_reason, created_at, updated_at
                FROM work_items WHERE id = ?
                """,
                (work_item_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown work item id: {work_item_id}")
        return _work_item_from_row(row)

    def get_attempt(self, attempt_id: str) -> AttemptRow:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT attempt_id, work_item_id, attempt_no, worker_id, lease_id, workspace_path,
                       session_dir, omp_session_file, state, started_at, ended_at, last_event_at,
                       exit_reason, error
                FROM attempts WHERE attempt_id = ?
                """,
                (attempt_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown attempt: {attempt_id}")
        return _attempt_from_row(row)

    def get_lease(self, lease_id: str) -> LeaseRow:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                       acquired_at, heartbeat_at, expires_at
                FROM leases WHERE lease_id = ?
                """,
                (lease_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown lease: {lease_id}")
        return _lease_from_row(row)

    def get_worker(self, worker_id: str) -> WorkerRow | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT worker_id, host, labels_json, capacity, running_count, state, last_seen_at FROM workers WHERE worker_id = ?",
                (worker_id,),
            ).fetchone()
        return _worker_from_row(row) if row is not None else None

    def get_workspace_ref(self, workspace_key: str, worker_id: str) -> WorkspaceRefRow | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT workspace_key, worker_id, workspace_path, session_dir, created_at, last_used_at
                FROM workspace_refs WHERE workspace_key=? AND worker_id=?
                """,
                (workspace_key, worker_id),
            ).fetchone()
        return _workspace_ref_from_row(row) if row is not None else None

    def get_work_item(self, identifier: str) -> WorkItemRecord | None:
        row = self.get_work_item_row(identifier)
        if row is None:
            return None
        return self._build_work_item_record(row)

    def list_work_items(self, *, limit: int = 100) -> list[WorkItemRecord]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, identifier, title, body, source_kind, repo_path, labels_json, priority,
                       state, retry_due_at, blocked_reason, created_at, updated_at
                FROM work_items
                ORDER BY updated_at DESC, created_at DESC
                LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
        return [self._build_work_item_record(_work_item_from_row(row)) for row in rows]

    def list_workers(self) -> list[WorkerRow]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT worker_id, host, labels_json, capacity, running_count, state, last_seen_at FROM workers ORDER BY worker_id"
            ).fetchall()
        return [_worker_from_row(row) for row in rows]

    def list_events(self, *, work_item_id: int | None = None, limit: int = 200) -> list[EventRow]:
        with self._lock:
            if work_item_id is None:
                rows = self._conn.execute(
                    "SELECT id, work_item_id, attempt_id, event_type, payload_json, ts FROM events ORDER BY id DESC LIMIT ?",
                    (int(limit),),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, work_item_id, attempt_id, event_type, payload_json, ts FROM events WHERE work_item_id=? ORDER BY id DESC LIMIT ?",
                    (work_item_id, int(limit)),
                ).fetchall()
        return [_event_from_row(row) for row in rows]

    def expire_leases(self, *, now: str | None = None) -> list[LeaseRow]:
        cutoff = now or _utcnow()
        with self._txn() as conn:
            rows = conn.execute(
                """
                SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                       acquired_at, heartbeat_at, expires_at
                FROM leases WHERE state='active' AND expires_at < ?
                """,
                (cutoff,),
            ).fetchall()
            expired = [_lease_from_row(row) for row in rows]
            for lease in expired:
                conn.execute(
                    "UPDATE leases SET state='expired', heartbeat_at=? WHERE lease_id=?",
                    (cutoff, lease.lease_id),
                )
                conn.execute(
                    "UPDATE work_items SET state='stale', updated_at=? WHERE id=? AND state IN ('leased','running','cancel_requested')",
                    (cutoff, lease.work_item_id),
                )
                conn.execute(
                    "UPDATE attempts SET state='stale', ended_at=?, last_event_at=? WHERE attempt_id=? AND state IN ('preparing','launching','running')",
                    (cutoff, cutoff, lease.attempt_id),
                )
                conn.execute(
                    """
                    UPDATE workers
                    SET running_count = CASE WHEN running_count > 0 THEN running_count - 1 ELSE 0 END,
                        last_seen_at=?
                    WHERE worker_id=?
                    """,
                    (cutoff, lease.worker_id),
                )
        return expired

    def _build_work_item_record(self, work_item: WorkItemRow) -> WorkItemRecord:
        with self._lock:
            attempt_rows = self._conn.execute(
                """
                SELECT attempt_id, work_item_id, attempt_no, worker_id, lease_id, workspace_path,
                       session_dir, omp_session_file, state, started_at, ended_at, last_event_at,
                       exit_reason, error
                FROM attempts WHERE work_item_id = ? ORDER BY attempt_no DESC
                """,
                (work_item.id,),
            ).fetchall()
            active_lease_row = self._conn.execute(
                """
                SELECT lease_id, work_item_id, attempt_id, worker_id, fencing_token, state,
                       acquired_at, heartbeat_at, expires_at
                FROM leases
                WHERE work_item_id = ? AND state = 'active'
                ORDER BY acquired_at DESC
                LIMIT 1
                """,
                (work_item.id,),
            ).fetchone()
            event_row = self._conn.execute(
                """
                SELECT id, work_item_id, attempt_id, event_type, payload_json, ts
                FROM events WHERE work_item_id = ? ORDER BY id DESC LIMIT 1
                """,
                (work_item.id,),
            ).fetchone()
        return WorkItemRecord(
            work_item=work_item,
            attempts=tuple(_attempt_from_row(row) for row in attempt_rows),
            active_lease=_lease_from_row(active_lease_row) if active_lease_row is not None else None,
            last_event=_event_from_row(event_row) if event_row is not None else None,
        )


_DB_SINGLETON: Database | None = None
_DB_LOCK = threading.Lock()


def get_database(path: Path) -> Database:
    global _DB_SINGLETON
    with _DB_LOCK:
        if _DB_SINGLETON is None or _DB_SINGLETON.path != path:
            if _DB_SINGLETON is not None:
                _DB_SINGLETON.close()
            _DB_SINGLETON = Database(path)
        return _DB_SINGLETON


def close_database() -> None:
    global _DB_SINGLETON
    with _DB_LOCK:
        if _DB_SINGLETON is not None:
            _DB_SINGLETON.close()
            _DB_SINGLETON = None


__all__ = [
    "AttemptLeaseBundle",
    "AttemptRow",
    "AttemptState",
    "Database",
    "EnqueueResult",
    "EventRow",
    "FinishResult",
    "LeaseRow",
    "LeaseState",
    "StaleLeaseError",
    "WorkItemRecord",
    "WorkItemRow",
    "WorkItemState",
    "WorkerRow",
    "WorkerState",
    "WorkspaceRefRow",
    "close_database",
    "get_database",
]
