"""Workspace allocation and lifecycle hooks."""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .workflow import WorkflowHooks

log = logging.getLogger(__name__)

WorkspaceHookName = Literal["after_create", "before_run", "after_run", "before_remove"]
_SANITIZE_RE = re.compile(r"[^A-Za-z0-9._-]")


class WorkspaceError(RuntimeError):
    """Workspace allocation or validation failed."""


class HookExecutionError(WorkspaceError):
    """A fatal workflow hook failed."""

    def __init__(self, result: HookResult) -> None:
        self.result = result
        reason = "timed out" if result.timed_out else f"exited {result.exit_code}"
        super().__init__(f"{result.hook_name} hook {reason}")


@dataclass(slots=True, frozen=True)
class WorkspaceLayout:
    identifier: str
    workspace_key: str
    workspace_path: Path
    repo_path: Path
    session_dir: Path
    artifacts_dir: Path
    context_dir: Path
    created_now: bool


@dataclass(slots=True, frozen=True)
class HookResult:
    hook_name: WorkspaceHookName
    command: str
    cwd: Path
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool


class WorkspaceManager:
    """Allocates per-item workspaces and runs repository-owned shell hooks."""

    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root.resolve(strict=False)
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    def describe(self, identifier: str) -> WorkspaceLayout:
        workspace_key = sanitize(identifier)
        if not workspace_key:
            raise WorkspaceError("workspace identifier produced an empty workspace key")
        workspace_path = self._workspace_path_for_key(workspace_key)
        repo_path = workspace_path / "repo"
        session_dir = workspace_path / ".omp-session"
        artifacts_dir = workspace_path / "artifacts"
        context_dir = workspace_path / "context"
        self._assert_under_root(workspace_path)
        self._assert_under_root(repo_path)
        self._assert_under_root(session_dir)
        self._assert_under_root(artifacts_dir)
        self._assert_under_root(context_dir)
        return WorkspaceLayout(
            identifier=identifier,
            workspace_key=workspace_key,
            workspace_path=workspace_path,
            repo_path=repo_path,
            session_dir=session_dir,
            artifacts_dir=artifacts_dir,
            context_dir=context_dir,
            created_now=not workspace_path.exists(),
        )

    def allocate(self, identifier: str) -> WorkspaceLayout:
        layout = self.describe(identifier)
        for path in (
            layout.workspace_path,
            layout.repo_path,
            layout.session_dir,
            layout.artifacts_dir,
            layout.context_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        return layout

    async def run_after_create(self, layout: WorkspaceLayout, hooks: WorkflowHooks) -> HookResult | None:
        if not layout.created_now or not hooks.after_create:
            return None
        return await self._run_hook_checked(
            hook_name="after_create",
            command=hooks.after_create,
            cwd=layout.repo_path,
            timeout_ms=hooks.timeout_ms,
        )

    async def prepare(self, *, identifier: str, hooks: WorkflowHooks) -> WorkspaceLayout:
        layout = self.allocate(identifier)
        await self.run_after_create(layout, hooks)
        return layout

    async def run_before_run(self, layout: WorkspaceLayout, hooks: WorkflowHooks) -> HookResult | None:
        self.validate_launch_cwd(layout, layout.repo_path)
        if not hooks.before_run:
            return None
        return await self._run_hook_checked(
            hook_name="before_run",
            command=hooks.before_run,
            cwd=layout.repo_path,
            timeout_ms=hooks.timeout_ms,
        )

    async def run_after_run(self, layout: WorkspaceLayout, hooks: WorkflowHooks) -> HookResult | None:
        if not hooks.after_run:
            return None
        return await self._run_hook_best_effort(
            hook_name="after_run",
            command=hooks.after_run,
            cwd=layout.repo_path,
            timeout_ms=hooks.timeout_ms,
        )

    async def remove_workspace(self, identifier: str, hooks: WorkflowHooks) -> bool:
        workspace_key = sanitize(identifier)
        if not workspace_key:
            raise WorkspaceError("workspace identifier produced an empty workspace key")
        workspace_path = self._workspace_path_for_key(workspace_key)
        if not workspace_path.exists():
            return False
        repo_path = workspace_path / "repo"
        hook_cwd = repo_path if repo_path.exists() else workspace_path
        if hooks.before_remove:
            await self._run_hook_best_effort(
                hook_name="before_remove",
                command=hooks.before_remove,
                cwd=hook_cwd,
                timeout_ms=hooks.timeout_ms,
            )
        shutil.rmtree(workspace_path)
        return True

    def validate_launch_cwd(self, layout: WorkspaceLayout, cwd: Path) -> None:
        resolved_cwd = cwd.resolve(strict=False)
        expected_repo_path = layout.repo_path.resolve(strict=False)
        if resolved_cwd != expected_repo_path:
            raise WorkspaceError(
                f"OMP cwd must equal workspace repo path: got {resolved_cwd}, expected {expected_repo_path}"
            )
        self._assert_under_root(layout.workspace_path)
        self._assert_under_root(layout.repo_path)

    def _workspace_path_for_key(self, workspace_key: str) -> Path:
        workspace_path = (self.workspace_root / workspace_key).resolve(strict=False)
        self._assert_under_root(workspace_path)
        return workspace_path

    def _assert_under_root(self, candidate: Path) -> None:
        resolved_root = self.workspace_root.resolve(strict=False)
        resolved_candidate = candidate.resolve(strict=False)
        try:
            resolved_candidate.relative_to(resolved_root)
        except ValueError as exc:
            raise WorkspaceError(
                f"workspace path escapes root: candidate={resolved_candidate} root={resolved_root}"
            ) from exc

    async def _run_hook_checked(
        self,
        *,
        hook_name: WorkspaceHookName,
        command: str,
        cwd: Path,
        timeout_ms: int,
    ) -> HookResult:
        result = await self._run_hook(hook_name=hook_name, command=command, cwd=cwd, timeout_ms=timeout_ms)
        if result.timed_out or result.exit_code not in (0, None):
            raise HookExecutionError(result)
        return result

    async def _run_hook_best_effort(
        self,
        *,
        hook_name: WorkspaceHookName,
        command: str,
        cwd: Path,
        timeout_ms: int,
    ) -> HookResult:
        result = await self._run_hook(hook_name=hook_name, command=command, cwd=cwd, timeout_ms=timeout_ms)
        if result.timed_out or result.exit_code not in (0, None):
            log.warning(
                "workspace hook failed but was ignored",
                extra={
                    "hook": hook_name,
                    "cwd": str(cwd),
                    "exit_code": result.exit_code,
                    "timed_out": result.timed_out,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                },
            )
        return result

    async def _run_hook(
        self,
        *,
        hook_name: WorkspaceHookName,
        command: str,
        cwd: Path,
        timeout_ms: int,
    ) -> HookResult:
        self._assert_under_root(cwd)
        proc = await asyncio.create_subprocess_exec(
            "sh",
            "-lc",
            command,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000.0)
            return HookResult(
                hook_name=hook_name,
                command=command,
                cwd=cwd,
                exit_code=proc.returncode,
                stdout=stdout.decode("utf-8", errors="replace"),
                stderr=stderr.decode("utf-8", errors="replace"),
                timed_out=False,
            )
        except TimeoutError:
            proc.kill()
            stdout, stderr = await proc.communicate()
            return HookResult(
                hook_name=hook_name,
                command=command,
                cwd=cwd,
                exit_code=proc.returncode,
                stdout=stdout.decode("utf-8", errors="replace"),
                stderr=stderr.decode("utf-8", errors="replace"),
                timed_out=True,
            )


def sanitize(identifier: str) -> str:
    return _SANITIZE_RE.sub("_", identifier)


__all__ = [
    "HookExecutionError",
    "HookResult",
    "WorkspaceError",
    "WorkspaceLayout",
    "WorkspaceManager",
    "sanitize",
]
