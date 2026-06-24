"""Workflow loading and prompt rendering."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any

import yaml

_ALLOWED_TOP_LEVEL_KEYS = frozenset({"queue", "workspace", "omp", "workers"})
_ALLOWED_TEMPLATE_FIELDS = frozenset(
    {
        "identifier",
        "title",
        "body",
        "workspace_path",
        "session_dir",
        "attempt_no",
        "repo_path",
    }
)
_DEFAULT_HOOK_TIMEOUT_MS = 60_000


class WorkflowError(RuntimeError):
    """Base error for workflow parsing or rendering."""


class WorkflowTemplateError(WorkflowError):
    """Raised when workflow prompt template is invalid."""


@dataclass(slots=True, frozen=True)
class WorkflowHooks:
    after_create: str | None = None
    before_run: str | None = None
    after_run: str | None = None
    before_remove: str | None = None
    timeout_ms: int = _DEFAULT_HOOK_TIMEOUT_MS


@dataclass(slots=True, frozen=True)
class WorkflowDefinition:
    path: Path
    queue: dict[str, Any]
    workspace: dict[str, Any]
    omp: dict[str, Any]
    workers: dict[str, Any]
    body_template: str
    hooks: WorkflowHooks

    def render_prompt(
        self,
        *,
        identifier: str,
        title: str,
        body: str,
        workspace_path: Path,
        session_dir: Path,
        attempt_no: int,
        repo_path: Path | None,
    ) -> str:
        template = Template(self.body_template)
        try:
            return template.substitute(
                identifier=identifier,
                title=title,
                body=body,
                workspace_path=str(workspace_path),
                session_dir=str(session_dir),
                attempt_no=str(attempt_no),
                repo_path=str(repo_path) if repo_path is not None else "",
            )
        except KeyError as exc:
            missing = exc.args[0] if exc.args else "unknown"
            raise WorkflowTemplateError(f"unknown workflow placeholder: {missing}") from exc


@dataclass(slots=True, frozen=True)
class RenderedPrompt:
    prompt: str | None
    blocked_reason: str | None = None
    blocked_details: str | None = None

    @property
    def blocked(self) -> bool:
        return self.blocked_reason is not None


class WorkflowStore:
    """Loads and renders the repository-owned workflow contract."""

    def __init__(self, workflow_path: Path) -> None:
        self.workflow_path = workflow_path

    def load(self) -> WorkflowDefinition:
        return parse_workflow(self.workflow_path)

    def render_prompt(
        self,
        *,
        identifier: str,
        title: str,
        body: str,
        workspace_path: Path,
        session_dir: Path,
        attempt_no: int,
        repo_path: Path | None,
    ) -> RenderedPrompt:
        workflow = self.load()
        try:
            prompt = workflow.render_prompt(
                identifier=identifier,
                title=title,
                body=body,
                workspace_path=workspace_path,
                session_dir=session_dir,
                attempt_no=attempt_no,
                repo_path=repo_path,
            )
        except WorkflowTemplateError as exc:
            return RenderedPrompt(
                prompt=None,
                blocked_reason="workflow_render_error",
                blocked_details=str(exc),
            )
        return RenderedPrompt(prompt=prompt)


def parse_workflow(path: Path) -> WorkflowDefinition:
    text = path.read_text(encoding="utf-8")
    front_matter, body = _split_front_matter(text)
    data = yaml.safe_load(front_matter) or {}
    if not isinstance(data, dict):
        raise WorkflowError("workflow front matter must decode to a mapping")
    keys = set(data)
    unknown = keys - _ALLOWED_TOP_LEVEL_KEYS
    if unknown:
        joined = ", ".join(sorted(str(item) for item in unknown))
        raise WorkflowError(f"unsupported workflow keys: {joined}")
    missing = _ALLOWED_TOP_LEVEL_KEYS - keys
    if missing:
        joined = ", ".join(sorted(missing))
        raise WorkflowError(f"missing workflow keys: {joined}")
    queue = _mapping_value(data.get("queue"), "queue")
    workspace = _mapping_value(data.get("workspace"), "workspace")
    omp = _mapping_value(data.get("omp"), "omp")
    workers = _mapping_value(data.get("workers"), "workers")
    _validate_template_body(body)
    hooks_mapping = _mapping_value(workspace.get("hooks") or {}, "workspace.hooks")
    hooks = WorkflowHooks(
        after_create=_string_or_none(hooks_mapping.get("after_create")),
        before_run=_string_or_none(hooks_mapping.get("before_run")),
        after_run=_string_or_none(hooks_mapping.get("after_run")),
        before_remove=_string_or_none(hooks_mapping.get("before_remove")),
        timeout_ms=_positive_int(hooks_mapping.get("timeout_ms"), default=_DEFAULT_HOOK_TIMEOUT_MS),
    )
    return WorkflowDefinition(
        path=path,
        queue=queue,
        workspace=workspace,
        omp=omp,
        workers=workers,
        body_template=body,
        hooks=hooks,
    )


def _split_front_matter(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        raise WorkflowError("workflow must start with YAML front matter")
    end_marker = "\n---\n"
    end = text.find(end_marker, 4)
    if end < 0:
        raise WorkflowError("workflow YAML front matter must end with ---")
    return text[4:end], text[end + len(end_marker) :]


def _validate_template_body(body: str) -> None:
    for match in Template.pattern.finditer(body):
        invalid = match.group("invalid")
        named = match.group("named")
        if invalid:
            raise WorkflowTemplateError(f"invalid workflow placeholder syntax near: {match.group(0)!r}")
        if named:
            raise WorkflowTemplateError(f"workflow placeholders must use braced form: ${{{named}}}")


def _mapping_value(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkflowError(f"{field_name} must be a mapping")
    return {str(key): item for key, item in value.items()}


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _positive_int(value: Any, *, default: int) -> int:
    if value is None:
        return default
    parsed = int(value)
    if parsed <= 0:
        raise WorkflowError("workspace.hooks.timeout_ms must be greater than zero")
    return parsed


__all__ = [
    "RenderedPrompt",
    "WorkflowDefinition",
    "WorkflowError",
    "WorkflowHooks",
    "WorkflowStore",
    "WorkflowTemplateError",
    "parse_workflow",
]
