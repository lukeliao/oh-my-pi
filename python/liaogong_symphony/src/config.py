"""Env-driven configuration for liaogong-symphony."""

from __future__ import annotations

from functools import cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Strongly typed runtime configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="LIAOGONG_SYMPHONY_",
        extra="ignore",
        case_sensitive=False,
    )

    sqlite_path: Path = Field(Path("./data/liaogong-symphony.sqlite"))
    workspace_root: Path = Field(Path("./data/workspaces"))
    log_dir: Path = Field(Path("./data/logs"))
    bind_host: str = Field("127.0.0.1")
    bind_port: int = Field(8090)
    workflow_path: Path = Field(Path("./WORKFLOW.md"))
    api_token: SecretStr | None = Field(None)
    omp_command: str = Field("omp")
    max_concurrency: int = Field(2)
    lease_ttl_seconds: float = Field(60.0)
    heartbeat_interval_seconds: float = Field(10.0)
    task_timeout_seconds: float = Field(2400.0)
    request_timeout_seconds: float = Field(120.0)
    max_retry_backoff_ms: int = Field(300000)
    worker_id: str | None = Field(None)
    worker_labels_raw: str = Field("default")
    remote_required_broker: bool = Field(True)

    @field_validator("api_token", mode="before")
    @classmethod
    def _blank_secret_disables(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("worker_id", mode="before")
    @classmethod
    def _blank_worker_id_disables(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("worker_labels_raw", mode="before")
    @classmethod
    def _coerce_worker_labels(cls, value: object) -> str:
        if value is None:
            return "default"
        if isinstance(value, str):
            return value
        if isinstance(value, (list, tuple, set, frozenset)):
            return ",".join(str(item) for item in value)
        return str(value)

    @property
    def worker_labels(self) -> tuple[str, ...]:
        items = [piece.strip() for piece in self.worker_labels_raw.split(",")]
        return tuple(item for item in items if item) or ("default",)

    def ensure_paths(self) -> None:
        for path in (self.workspace_root, self.sqlite_path.parent, self.log_dir):
            path.mkdir(parents=True, exist_ok=True)


@cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def reset_settings_cache() -> None:
    """Invalidate the cached settings singleton."""

    get_settings.cache_clear()


__all__ = ["Settings", "get_settings", "reset_settings_cache"]
