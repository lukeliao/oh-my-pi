"""OMP RPC adapter for one liaogong-symphony attempt."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from omp_rpc import (
    ExtensionUiRequest,
    HostToolContext,
    ListenerErrorEvent,
    MessageUpdateEvent,
    RpcClient,
    RpcError,
    RpcProcessExitError,
    RpcProtocolError,
    ToolExecutionEndEvent,
    host_tool,
)

from .db import AttemptState

NoteKind = Literal["progress", "evidence", "warning"]
RunOutcome = Literal["completed", "blocked", "cancelled", "failed"]


class AttemptStateSink(Protocol):
    def touch_attempt(
        self,
        attempt_id: str,
        *,
        state: AttemptState | None = None,
        last_event_at: str | None = None,
        error: str | None = None,
        exit_reason: str | None = None,
        omp_session_file: str | None = None,
    ) -> Any: ...

    def mark_blocked(
        self,
        *,
        identifier: str,
        reason: str,
        retry_due_at: str | None = None,
    ) -> Any: ...

    def append_event(
        self,
        *,
        event_type: str,
        payload: dict[str, Any],
        work_item_id: int | None = None,
        attempt_id: str | None = None,
    ) -> Any: ...


@dataclass(slots=True, frozen=True)
class BlockedToolArgs:
    reason: str
    details: str | None = None


@dataclass(slots=True, frozen=True)
class NoteToolArgs:
    kind: NoteKind
    message: str


@dataclass(slots=True, frozen=True)
class OmpRunRequest:
    attempt_id: str
    work_item_id: int
    identifier: str
    prompt: str
    cwd: Path
    session_dir: Path
    omp_command: str = "omp"
    provider: str | None = None
    model: str | None = None
    thinking: str | None = None
    append_system_prompt: str | None = None
    provider_session_id: str | None = None
    tools: tuple[str, ...] | None = None
    host_uris: tuple[Any, ...] = ()
    env: dict[str, str] | None = None
    startup_timeout: float = 60.0
    request_timeout: float = 120.0
    task_timeout: float = 2400.0
    attempt_no: int = 1


@dataclass(slots=True, frozen=True)
class OmpRunResult:
    outcome: RunOutcome
    assistant_text: str | None
    blocked_reason: str | None
    blocked_details: str | None
    error: str | None
    session_file: str | None
    resumed: bool


class OmpAttemptRunner:
    """Runs a single OMP RPC prompt with host tools and audited events."""

    def __init__(self, state_sink: AttemptStateSink) -> None:
        self._state_sink = state_sink
        self._lock = threading.Lock()
        self._client: RpcClient | None = None
        self._blocked_reason: str | None = None
        self._blocked_details: str | None = None
        self._cancel_requested = False

    def run(
        self,
        request: OmpRunRequest,
        *,
        on_cancel_ready: Callable[[Callable[[], None]], None] | None = None,
    ) -> OmpRunResult:
        resumed = _has_prior_session(request.session_dir)
        extra_args: tuple[str, ...] = ("--continue",) if resumed else ()
        self._blocked_reason = None
        self._blocked_details = None
        self._state_sink.touch_attempt(request.attempt_id, state="launching")
        with RpcClient(
            executable=request.omp_command,
            provider=request.provider,
            model=request.model,
            session_dir=request.session_dir,
            cwd=request.cwd,
            env=request.env,
            thinking=request.thinking,
            append_system_prompt=request.append_system_prompt,
            provider_session_id=request.provider_session_id,
            tools=request.tools,
            custom_tools=self._build_host_tools(request),
            host_uris=request.host_uris,
            no_session=False,
            no_title=True,
            startup_timeout=request.startup_timeout,
            request_timeout=request.request_timeout,
            max_event_history=50_000,
            extra_args=extra_args,
        ) as client:
            with self._lock:
                self._client = client
                self._cancel_requested = False
            cancel_hook = self._build_cancel_hook(client)
            if on_cancel_ready is not None:
                on_cancel_ready(cancel_hook)
            try:
                client.install_headless_ui(on_request=lambda ui: self._on_ui_request(request, ui))
                self._register_listeners(request, client)
                self._refresh_session_file(request, client)
                self._state_sink.touch_attempt(request.attempt_id, state="running")
                turn = client.prompt_and_wait(request.prompt, timeout=request.task_timeout)
                self._refresh_session_file(request, client)
                outcome: RunOutcome = "blocked" if self._blocked_reason is not None else "completed"
                return OmpRunResult(
                    outcome=outcome,
                    assistant_text=turn.assistant_text,
                    blocked_reason=self._blocked_reason,
                    blocked_details=self._blocked_details,
                    error=None,
                    session_file=self._safe_session_file(client),
                    resumed=resumed,
                )
            except RpcProcessExitError as exc:
                return OmpRunResult(
                    outcome="cancelled" if self._cancel_requested else "failed",
                    assistant_text=None,
                    blocked_reason=self._blocked_reason,
                    blocked_details=self._blocked_details,
                    error=str(exc),
                    session_file=self._safe_session_file(client),
                    resumed=resumed,
                )
            except RpcError as exc:
                return OmpRunResult(
                    outcome="failed",
                    assistant_text=None,
                    blocked_reason=self._blocked_reason,
                    blocked_details=self._blocked_details,
                    error=str(exc),
                    session_file=self._safe_session_file(client),
                    resumed=resumed,
                )
            finally:
                with self._lock:
                    self._client = None

    def cancel(self) -> None:
        client: RpcClient | None
        with self._lock:
            client = self._client
            self._cancel_requested = True
        if client is None:
            return
        self._build_cancel_hook(client)()

    def _build_cancel_hook(self, client: RpcClient) -> Callable[[], None]:
        def _cancel_hook() -> None:
            with self._lock:
                self._cancel_requested = True
            try:
                client.stop()
            finally:
                client._mark_closed(RpcProcessExitError("cancelled by operator"))  # noqa: SLF001

        return _cancel_hook

    def _build_host_tools(self, request: OmpRunRequest) -> tuple[Any, ...]:
        def decode_blocked(payload: dict[str, Any]) -> BlockedToolArgs:
            reason = str(payload.get("reason", "")).strip()
            if not reason:
                raise ValueError("mark_work_item_blocked requires non-empty reason")
            details = payload.get("details")
            cleaned_details = str(details).strip() if details is not None else None
            return BlockedToolArgs(reason=reason, details=cleaned_details or None)

        def execute_blocked(args: BlockedToolArgs, _ctx: HostToolContext[Any]) -> dict[str, Any]:
            self._blocked_reason = args.reason
            self._blocked_details = args.details
            self._state_sink.mark_blocked(identifier=request.identifier, reason=args.reason)
            self._state_sink.append_event(
                event_type="work_item_blocked",
                payload={"reason": args.reason, "details": args.details},
                work_item_id=request.work_item_id,
                attempt_id=request.attempt_id,
            )
            return {"details": {"ok": True}}

        def decode_note(payload: dict[str, Any]) -> NoteToolArgs:
            kind = str(payload.get("kind", "")).strip()
            message = str(payload.get("message", "")).strip()
            if kind not in ("progress", "evidence", "warning"):
                raise ValueError("record_work_item_note kind must be progress, evidence, or warning")
            if not message:
                raise ValueError("record_work_item_note requires non-empty message")
            return NoteToolArgs(kind=kind, message=message)

        def execute_note(args: NoteToolArgs, _ctx: HostToolContext[Any]) -> dict[str, Any]:
            self._state_sink.append_event(
                event_type="work_item_note",
                payload={"kind": args.kind, "message": args.message},
                work_item_id=request.work_item_id,
                attempt_id=request.attempt_id,
            )
            return {"details": {"ok": True}}

        return (
            host_tool(
                name="mark_work_item_blocked",
                description="Mark the current work item blocked and record the reason.",
                parameters={
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string"},
                        "details": {"type": "string"},
                    },
                    "required": ["reason"],
                    "additionalProperties": False,
                },
                decode=decode_blocked,
                execute=execute_blocked,
            ),
            host_tool(
                name="record_work_item_note",
                description="Record a structured progress/evidence/warning note for the current work item.",
                parameters={
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["progress", "evidence", "warning"]},
                        "message": {"type": "string"},
                    },
                    "required": ["kind", "message"],
                    "additionalProperties": False,
                },
                decode=decode_note,
                execute=execute_note,
            ),
        )

    def _register_listeners(self, request: OmpRunRequest, client: RpcClient) -> None:
        client.on_agent_start(lambda event: self._record_event(request, event.type, event))
        client.on_agent_end(lambda event: self._record_event(request, event.type, event))
        client.on_turn_start(lambda event: self._record_event(request, event.type, event))
        client.on_turn_end(lambda event: self._record_event(request, event.type, event))
        client.on_message_update(lambda event: self._on_message_update(request, event))
        client.on_tool_execution_start(lambda event: self._record_event(request, event.type, event))
        client.on_tool_execution_update(lambda event: self._record_event(request, event.type, event))
        client.on_tool_execution_end(lambda event: self._on_tool_execution_end(request, event))
        client.on_auto_retry_start(lambda event: self._record_event(request, event.type, event))
        client.on_auto_retry_end(lambda event: self._record_event(request, event.type, event))
        client.on_extension_error(lambda event: self._record_event(request, event.type, event))
        client.on_protocol_error(lambda event: self._record_protocol_error(request, event))
        client.on_listener_error(lambda event: self._record_listener_error(request, event))

    def _on_ui_request(self, request: OmpRunRequest, ui_request: ExtensionUiRequest) -> None:
        if not ui_request.requires_response():
            return
        self._record_payload(
            request,
            event_type="ui_request_cancelled",
            payload=_jsonify(ui_request),
        )

    def _on_message_update(self, request: OmpRunRequest, event: MessageUpdateEvent) -> None:
        self._record_event(request, event.type, event)

    def _on_tool_execution_end(self, request: OmpRunRequest, event: ToolExecutionEndEvent) -> None:
        self._record_event(request, event.type, event)

    def _record_protocol_error(self, request: OmpRunRequest, error: RpcProtocolError) -> None:
        self._record_payload(
            request,
            event_type="protocol_error",
            payload={
                "command": error.command,
                "request_id": error.request_id,
                "error": error.remote_error,
                "payload": error.payload,
            },
        )

    def _record_listener_error(self, request: OmpRunRequest, error: ListenerErrorEvent) -> None:
        self._record_payload(
            request,
            event_type="listener_error",
            payload={
                "listener_kind": error.listener_kind,
                "source_type": error.source_type,
                "listener": repr(error.listener),
                "error": str(error.error),
            },
        )

    def _record_event(self, request: OmpRunRequest, event_type: str, event: Any) -> None:
        self._record_payload(request, event_type=event_type, payload=_jsonify(event))

    def _record_payload(self, request: OmpRunRequest, *, event_type: str, payload: dict[str, Any]) -> None:
        self._state_sink.touch_attempt(request.attempt_id, state="running")
        self._state_sink.append_event(
            event_type=event_type,
            payload=payload,
            work_item_id=request.work_item_id,
            attempt_id=request.attempt_id,
        )

    def _refresh_session_file(self, request: OmpRunRequest, client: RpcClient) -> None:
        session_file = self._safe_session_file(client)
        if session_file is not None:
            self._state_sink.touch_attempt(request.attempt_id, omp_session_file=session_file)

    @staticmethod
    def _safe_session_file(client: RpcClient) -> str | None:
        try:
            state = client.get_state()
        except RpcError:
            return None
        return state.session_file


def _has_prior_session(session_dir: Path) -> bool:
    return any(path.suffix == ".jsonl" for path in session_dir.glob("*.jsonl"))


def _jsonify(value: Any) -> Any:
    if is_dataclass(value):
        return _jsonify(asdict(value))
    if isinstance(value, dict):
        return {str(key): _jsonify(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonify(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, BaseException):
        return str(value)
    return value


__all__ = ["AttemptStateSink", "OmpAttemptRunner", "OmpRunRequest", "OmpRunResult", "RunOutcome"]
