"""Worker settings, read from the environment (and the repo's .env.local for development)."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_env_file(path: Path, environ: dict[str, str] | None = None) -> None:
    """Loads KEY=VALUE lines without overriding variables that are already set."""
    environ = os.environ if environ is None else environ
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        environ.setdefault(key.strip(), value)


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    database_url: str
    node_env: str = "development"
    adapter_mode: str = "fake"
    data_dir: Path = REPO_ROOT / ".data" / "uploads"
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_endpoint: str | None = None
    worker_id: str = field(default_factory=socket.gethostname)
    poll_seconds: float = 2.0
    heartbeat_seconds: float = 15.0
    # A running job with no heartbeat for this long is taken back and retried.
    stale_job_seconds: int = 600
    # "whisper" runs faster-whisper. "fake" produces canned text so the pipeline can be tried
    # without a model; it is refused in production.
    transcriber: str = "whisper"
    whisper_model: str = "large-v3"
    whisper_model_path: str | None = None
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_cpu_threads: int = 0
    allow_model_download: bool = False
    # Which audio to transcribe. The cleaned copy usually reads better; fall back to the original
    # if a tape transcribes worse after cleanup.
    transcribe_source: str = "cleaned"
    low_confidence_threshold: float = 0.5

    @property
    def real_mode(self) -> bool:
        return self.adapter_mode == "real"


def from_env(environ: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if environ is None else environ)
    url = env.get("DATABASE_URL")
    if not url:
        raise ConfigError("DATABASE_URL is not set. Copy .env.example to .env.local and set it.")
    node_env = env.get("NODE_ENV", "development")
    mode = env.get("ADAPTER_MODE", "fake")
    if mode not in ("fake", "real"):
        raise ConfigError(f"ADAPTER_MODE must be fake or real, not {mode!r}.")
    if mode == "real" and node_env != "production":
        # Same rule as the app: nothing touches real storage from development or tests.
        raise ConfigError("ADAPTER_MODE=real is only allowed when NODE_ENV=production.")
    if mode == "real" and not (env.get("S3_BUCKET") and env.get("S3_REGION")):
        raise ConfigError("S3_BUCKET and S3_REGION are required when ADAPTER_MODE=real.")

    transcriber = env.get("TRANSCRIBER", "whisper")
    if transcriber not in ("whisper", "fake"):
        raise ConfigError(f"TRANSCRIBER must be whisper or fake, not {transcriber!r}.")
    if transcriber == "fake" and node_env == "production":
        raise ConfigError("TRANSCRIBER=fake is not allowed in production.")
    source = env.get("TRANSCRIBE_SOURCE", "cleaned")
    if source not in ("cleaned", "original"):
        raise ConfigError("TRANSCRIBE_SOURCE must be cleaned or original.")

    kwargs: dict = {}
    if env.get("DATA_DIR"):
        kwargs["data_dir"] = Path(env["DATA_DIR"]).expanduser()
    if env.get("WORKER_ID"):
        kwargs["worker_id"] = env["WORKER_ID"]
    return Config(
        database_url=url,
        node_env=node_env,
        adapter_mode=mode,
        s3_bucket=env.get("S3_BUCKET") or None,
        s3_region=env.get("S3_REGION") or None,
        s3_endpoint=env.get("S3_ENDPOINT") or None,
        poll_seconds=float(env.get("POLL_SECONDS", "2")),
        heartbeat_seconds=float(env.get("HEARTBEAT_SECONDS", "15")),
        stale_job_seconds=int(env.get("STALE_JOB_SECONDS", "600")),
        transcriber=transcriber,
        whisper_model=env.get("WHISPER_MODEL", "large-v3"),
        whisper_model_path=env.get("WHISPER_MODEL_PATH") or None,
        whisper_device=env.get("WHISPER_DEVICE", "cpu"),
        whisper_compute_type=env.get("WHISPER_COMPUTE", "int8"),
        whisper_cpu_threads=int(env.get("WHISPER_CPU_THREADS", "0")),
        allow_model_download=env.get("ALLOW_MODEL_DOWNLOAD") == "1",
        transcribe_source=source,
        low_confidence_threshold=float(env.get("LOW_CONFIDENCE_THRESHOLD", "0.5")),
        **kwargs,
    )
