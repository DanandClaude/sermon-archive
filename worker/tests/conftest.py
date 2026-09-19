from __future__ import annotations

import re
import subprocess
from pathlib import Path

import numpy as np
import pytest


def ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", *args],
        capture_output=True, text=True, check=True,
    )  # fmt: skip


def decode_mono(path: Path, rate: int = 8000) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(rate),
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    )  # fmt: skip
    return np.frombuffer(out.stdout, dtype="<f4")


def tone_magnitude(samples: np.ndarray, hz: float, rate: int = 8000) -> float:
    """Strength of one frequency, from the middle of the clip so fades don't count."""
    n = len(samples)
    middle = samples[n // 4 : 3 * n // 4] * np.hanning(len(samples[n // 4 : 3 * n // 4]))
    spectrum = np.abs(np.fft.rfft(middle))
    freqs = np.fft.rfftfreq(len(middle), 1 / rate)
    return float(spectrum[np.argmin(np.abs(freqs - hz))])


def integrated_lufs(path: Path) -> float:
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "ebur128=framelog=quiet",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )  # fmt: skip
    summary = proc.stderr[proc.stderr.rindex("Integrated loudness") :]
    return float(re.search(r"I:\s+(-?\d+\.\d+) LUFS", summary).group(1))


@pytest.fixture(scope="session")
def audio_dir(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("audio")


@pytest.fixture(scope="session")
def hummy_wav(audio_dir) -> Path:
    """8 seconds: a 300 Hz tone (standing in for a voice), 60 Hz mains hum, and hiss."""
    path = audio_dir / "hummy.wav"
    ffmpeg(
        "-filter_complex",
        "sine=f=300:d=8:r=44100,volume=0.25[a];sine=f=60:d=8:r=44100,volume=0.25[b];"
        "anoisesrc=d=8:a=0.01:r=44100[c];[a][b][c]amix=inputs=3:normalize=0",
        "-ac", "1", str(path),
    )  # fmt: skip
    return path


@pytest.fixture(scope="session")
def half_silent_wav(audio_dir) -> Path:
    """3 seconds of silence, then 3 seconds of tone."""
    path = audio_dir / "half_silent.wav"
    ffmpeg(
        "-filter_complex",
        "anullsrc=r=44100:cl=mono,atrim=duration=3[s];sine=f=440:d=3:r=44100,volume=4[t];"
        "[s][t]concat=n=2:v=0:a=1",
        "-ac", "1", str(path),
    )  # fmt: skip
    return path


@pytest.fixture(scope="session")
def silent_wav(audio_dir) -> Path:
    path = audio_dir / "silent.wav"
    ffmpeg("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "3", str(path))
    return path


@pytest.fixture()
def not_audio(tmp_path) -> Path:
    path = tmp_path / "not-audio.mp3"
    path.write_bytes(b"This is just text pretending to be a recording.")
    return path


# ---------------------------------------------------------------------------------------------
# Database and pipeline fixtures. These use a separate database whose name ends in _test, built
# from the same migrations the app uses, so the worker is always tested against the real schema.

import os  # noqa: E402
import shutil  # noqa: E402
import uuid  # noqa: E402

import psycopg  # noqa: E402

from sermon_worker import queue  # noqa: E402
from sermon_worker.config import Config  # noqa: E402
from sermon_worker.store import LocalStore  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[2] / "drizzle"
TABLES = (
    "worker_heartbeats, storage_objects, verification_runs, storage_targets, analyses, scripture_refs, sermon_tags, tags, transcripts, jobs, uploads, "
    "audio_assets, sermons, "
    "login_tokens, sessions, audit_log, settings, users"
)


@pytest.fixture(scope="session")
def db_url() -> str:
    url = os.environ.get(
        "WORKER_TEST_DATABASE_URL", "postgres://localhost:5432/sermon_archive_worker_test"
    )
    name = url.rsplit("/", 1)[1].split("?")[0]
    if not name.endswith("_test"):
        raise RuntimeError(f"Refusing to reset {name!r}: test database names must end in _test.")
    admin_url = url.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        exists = admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        if not exists:
            admin.execute(f'CREATE DATABASE "{name}"')
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
        conn.execute("DROP SCHEMA IF EXISTS drizzle CASCADE")
        conn.execute("CREATE SCHEMA public")
        for sql_file in sorted(MIGRATIONS.glob("*.sql")):
            for statement in sql_file.read_text().split("--> statement-breakpoint"):
                if statement.strip():
                    conn.execute(statement)
    return url


@pytest.fixture()
def conn(db_url):
    connection = queue.connect(db_url)
    connection.execute(f"TRUNCATE TABLE {TABLES} RESTART IDENTITY CASCADE")
    yield connection
    connection.close()


@pytest.fixture()
def store(tmp_path) -> LocalStore:
    return LocalStore(tmp_path / "store")


@pytest.fixture()
def config(db_url, tmp_path) -> Config:
    return Config(
        database_url=db_url,
        worker_id="test-worker",
        transcriber="fake",
        data_dir=tmp_path / "store",
    )


def make_user(conn, role="contributor") -> str:
    row = conn.execute(
        "INSERT INTO users (email, name, role) VALUES (%s, 'Test User', %s::user_role) RETURNING id",
        (f"{uuid.uuid4()}@example.test", role),
    ).fetchone()
    return str(row["id"])


def make_sermon(conn, status="uploaded", speaker=None, deleted=False) -> str:
    row = conn.execute(
        "INSERT INTO sermons (contributor_id, status, speaker, deleted_at) "
        "VALUES (%s, %s::sermon_status, %s, %s) RETURNING id",
        (make_user(conn), status, speaker, "2026-01-01" if deleted else None),
    ).fetchone()
    return str(row["id"])


def add_original(conn, store: LocalStore, sermon_id: str, source: Path | None, name="original.wav"):
    """Puts an uploaded original in storage and records it, as a finished upload would."""
    key = f"originals/{sermon_id}/{name}"
    target = store.root / "objects" / key
    target.parent.mkdir(parents=True, exist_ok=True)
    if source is not None:
        shutil.copyfile(source, target)
    conn.execute(
        "INSERT INTO audio_assets (sermon_id, kind, storage_key, sha256, bytes, mime, original_filename) "
        "VALUES (%s, 'original', %s, 'x', 1, 'audio/wav', %s)",
        (sermon_id, key, name),
    )
    return key


def add_job(conn, sermon_id: str, job_type="clean", **cols) -> str:
    row = conn.execute(
        "INSERT INTO jobs (sermon_id, type) VALUES (%s, %s::job_type) RETURNING id",
        (sermon_id, job_type),
    ).fetchone()
    job_id = str(row["id"])
    for column, value in cols.items():
        conn.execute(f"UPDATE jobs SET {column} = %s WHERE id = %s", (value, job_id))
    return job_id


def job_row(conn, job_id: str) -> dict:
    return conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone()


def sermon_row(conn, sermon_id: str) -> dict:
    return conn.execute("SELECT * FROM sermons WHERE id = %s", (sermon_id,)).fetchone()


def encrypt_json(value: dict, key: bytes | None = None) -> str:
    """Writes a value the way the app does, so the worker's decryption is tested on its format."""
    import base64
    import json as _json

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    from sermon_worker.secrets_box import secrets_key

    key = key or secrets_key(None, False)
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, _json.dumps(value).encode(), None)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return f"v1.{b64(iv)}.{b64(sealed[-16:])}.{b64(sealed[:-16])}"


def add_target(
    conn, role: str, folder: Path | None, kind="local", account=None, config=None
) -> str:
    """Connects a storage target the way the app's Connections screen does."""
    settings = config or {"kind": kind, "path": str(folder)}
    row = conn.execute(
        "INSERT INTO storage_targets (role, provider, encrypted_config, account_label, root_folder_name, "
        "connected_at) VALUES (%s::storage_role, %s, %s, %s, %s, now()) RETURNING id",
        (
            role, kind, encrypt_json(settings), account or f"Development folder ({role})",
            "Sermon Archive" if role == "shared" else "Sermon Archive Backup",
        ),
    ).fetchone()  # fmt: skip
    return str(row["id"])
