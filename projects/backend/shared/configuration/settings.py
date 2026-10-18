from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NEWSBEE_", extra="ignore")

    data_dir: Path = ROOT / ".local" / "data"
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str | None = None
    mailpit_host: str = "127.0.0.1"
    mailpit_smtp_port: int = Field(default=1025, ge=1, le=65535)
    heartbeat_interval: float = Field(default=2, ge=0.1, le=10)
    heartbeat_max_age: float = Field(default=15, ge=15)

    @field_validator("ollama_model", mode="before")
    @classmethod
    def empty_model(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("ollama_url")
    @classmethod
    def local_ollama(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme != "http"
            or url.hostname not in {"127.0.0.1", "localhost", "::1"}
            or (url.port is not None and not 1 <= url.port <= 65535)
            or url.username
            or url.password
            or url.path not in {"", "/"}
            or url.query
            or url.fragment
        ):
            raise ValueError("Stage 1 Ollama must use a loopback HTTP origin")
        return value.rstrip("/")

    @field_validator("mailpit_host")
    @classmethod
    def local_mailpit(cls, value: str) -> str:
        if value not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Stage 1 email is restricted to a loopback mail sink")
        return value

    @property
    def database(self) -> Path:
        return self.data_dir / "newsbee.sqlite3"

    @property
    def evidence_dir(self) -> Path:
        return self.data_dir / "evidence"
