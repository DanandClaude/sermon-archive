"""Nightly backups of the app's own database, and restoring them.

    python -m sermon_worker.backup daemon      run every night (what the Docker "backup" service does)
    python -m sermon_worker.backup run         take one backup now
    python -m sermon_worker.backup list        show what is kept
    python -m sermon_worker.backup restore latest --into postgres://.../new_database

The sermon audio and files are not in the database and are not backed up here (they live in the
upload bucket and the two Drive accounts). This protects the records: people, sermons, transcripts,
scripture lists, settings and the audit log.

- A backup is a `pg_dump` in Postgres's custom format, optionally encrypted with a passphrase
  (AES-256-GCM, key from scrypt). Set BACKUP_PASSPHRASE and keep it somewhere safe: without it an
  encrypted backup cannot be read.
- Kept: one per day for 14 days, and each Sunday's copy for 8 weeks (`db-backups/daily/` and
  `db-backups/weekly/`). Only files under that prefix are ever listed or deleted.
- The result of each run is saved in the `settings` table (`backup_last`) so the app can show it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Protocol

import psycopg
from psycopg.types.json import Jsonb

from . import queue
from .config import REPO_ROOT, Config, ConfigError, from_env, load_env_file

PREFIX = "db-backups/"
DAILY_DAYS = 14
WEEKLY_DAYS = 56
MAGIC = b"SAB1"  # marks an encrypted backup: MAGIC + salt(16) + nonce(12) + ciphertext+tag
SCRYPT = {"n": 2**15, "r": 8, "p": 1}

_NAME = re.compile(r"^db-backups/(daily|weekly)/sermon-archive-(\d{4}-\d{2}-\d{2})\.dump(\.enc)?$")


class BackupError(Exception):
    """Something a person needs to know about, in plain words."""


# -- encryption ---------------------------------------------------------------------------------


def _key(passphrase: str, salt: bytes) -> bytes:
    return hashlib.scrypt(passphrase.encode(), salt=salt, dklen=32, maxmem=2**27, **SCRYPT)


def encrypt_file(src: Path, dest: Path, passphrase: str) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, nonce = os.urandom(16), os.urandom(12)
    dest.write_bytes(
        MAGIC
        + salt
        + nonce
        + AESGCM(_key(passphrase, salt)).encrypt(nonce, src.read_bytes(), MAGIC)
    )


def decrypt_file(src: Path, dest: Path, passphrase: str) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    blob = src.read_bytes()
    if not blob.startswith(MAGIC):
        raise BackupError("This file is not an encrypted backup.")
    salt, nonce, body = blob[4:20], blob[20:32], blob[32:]
    try:
        dest.write_bytes(AESGCM(_key(passphrase, salt)).decrypt(nonce, body, MAGIC))
    except Exception as error:
        raise BackupError("Wrong passphrase, or the backup file is damaged.") from error


# -- where backups are kept ---------------------------------------------------------------------


class BackupStore(Protocol):
    def put(self, key: str, src: Path) -> None: ...
    def get(self, key: str, dest: Path) -> None: ...
    def list(self) -> list[str]: ...
    def delete(self, key: str) -> None: ...


def _check(key: str) -> None:
    if not _NAME.match(key):
        raise BackupError(f"Refusing to touch {key!r}: it is not a backup file.")


class LocalBackupStore:
    """A folder. For tests, and for a church that mounts a backup disk instead of using a bucket."""

    def __init__(self, root: Path):
        self.root = root

    def put(self, key: str, src: Path) -> None:
        _check(key)
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)

    def get(self, key: str, dest: Path) -> None:
        _check(key)
        shutil.copyfile(self.root / key, dest)

    def list(self) -> list[str]:
        base = self.root / PREFIX
        return sorted(p.relative_to(self.root).as_posix() for p in base.rglob("*") if p.is_file())

    def delete(self, key: str) -> None:
        _check(key)
        (self.root / key).unlink(missing_ok=True)


class S3BackupStore:
    """AWS S3 or a compatible service, under `db-backups/` only."""

    def __init__(self, bucket: str, region: str, endpoint: str | None = None, client=None):
        import boto3

        self.bucket = bucket
        self.client = client or boto3.client("s3", region_name=region, endpoint_url=endpoint)

    def put(self, key: str, src: Path) -> None:
        _check(key)
        self.client.upload_file(str(src), self.bucket, key)

    def get(self, key: str, dest: Path) -> None:
        _check(key)
        self.client.download_file(self.bucket, key, str(dest))

    def list(self) -> list[str]:
        keys: list[str] = []
        for page in self.client.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=PREFIX
        ):
            keys += [o["Key"] for o in page.get("Contents", [])]
        return sorted(keys)

    def delete(self, key: str) -> None:
        _check(key)
        self.client.delete_object(Bucket=self.bucket, Key=key)


def make_store(config: Config) -> BackupStore:
    if config.real_mode:
        assert config.s3_bucket and config.s3_region
        return S3BackupStore(config.s3_bucket, config.s3_region, config.s3_endpoint)
    return LocalBackupStore(
        Path(os.environ.get("BACKUP_LOCAL_DIR", config.data_dir.parent / "backups"))
    )


# -- names and keeping the right ones -----------------------------------------------------------


def backup_key(kind: str, day: date, encrypted: bool) -> str:
    return f"{PREFIX}{kind}/sermon-archive-{day.isoformat()}.dump{'.enc' if encrypted else ''}"


@dataclass(frozen=True)
class Kept:
    key: str
    kind: str
    day: date


def parse_key(key: str) -> Kept | None:
    match = _NAME.match(key)
    if not match:
        return None
    try:
        return Kept(key, match.group(1), date.fromisoformat(match.group(2)))
    except ValueError:
        return None


def to_delete(keys: list[str], today: date) -> list[str]:
    """Daily backups older than 14 days and weekly ones older than 8 weeks. The newest of each kind
    is always kept, and anything that does not look like one of ours is left alone."""
    kept = [k for k in (parse_key(x) for x in keys) if k]
    limits = {"daily": timedelta(days=DAILY_DAYS), "weekly": timedelta(days=WEEKLY_DAYS)}
    newest = {kind: max((k.day for k in kept if k.kind == kind), default=None) for kind in limits}
    return [k.key for k in kept if today - k.day > limits[k.kind] and k.day != newest[k.kind]]


# -- taking and restoring a backup --------------------------------------------------------------


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise BackupError(f"{name} is not installed on this machine.")
    return path


def dump(database_url: str, out: Path) -> None:
    result = subprocess.run(
        [_tool("pg_dump"), "--format=custom", "--no-owner", "--no-privileges", "--file", str(out), database_url],
        capture_output=True, text=True,
    )  # fmt: skip
    if result.returncode != 0:
        raise BackupError(f"pg_dump failed: {result.stderr.strip()[-300:]}")


def record(conn: psycopg.Connection, status: dict) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('backup_last', %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (Jsonb(status),),
    )


def run_backup(
    database_url: str, store: BackupStore, passphrase: str | None, now: datetime | None = None
) -> dict:
    """Takes one backup, keeps the right ones, and returns what happened."""
    now = now or datetime.now().astimezone()
    today = now.date()
    with tempfile.TemporaryDirectory(prefix="sermon-backup-") as tmp:
        raw = Path(tmp) / "db.dump"
        dump(database_url, raw)
        if raw.stat().st_size == 0:
            raise BackupError("The database dump was empty.")
        ready = raw
        if passphrase:
            ready = Path(tmp) / "db.dump.enc"
            encrypt_file(raw, ready, passphrase)
        size = ready.stat().st_size
        store.put(backup_key("daily", today, bool(passphrase)), ready)
        weekly = today.weekday() == 6  # Sunday
        if weekly:
            store.put(backup_key("weekly", today, bool(passphrase)), ready)
    removed = to_delete(store.list(), today)
    for key in removed:
        store.delete(key)
    return {
        "ok": True,
        "at": now.isoformat(),
        "key": backup_key("daily", today, bool(passphrase)),
        "bytes": size,
        "weekly": weekly,
        "encrypted": bool(passphrase),
        "removed": len(removed),
    }


def latest(keys: list[str]) -> str:
    daily = sorted(
        (k for k in (parse_key(x) for x in keys) if k and k.kind == "daily"), key=lambda k: k.day
    )
    if not daily:
        raise BackupError("There are no backups to restore.")
    return daily[-1].key


def restore(
    store: BackupStore, key: str, into_url: str, passphrase: str | None, *, overwrite: bool = False
) -> None:
    """Restores a backup into a database. By default the database must be empty, so a restore can
    never silently replace data that is there."""
    if key == "latest":
        key = latest(store.list())
    with psycopg.connect(into_url, autocommit=True) as conn:
        tables = conn.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
        ).fetchone()[0]
    if tables and not overwrite:
        raise BackupError(
            f"The target database already has {tables} tables. Restore into an empty database, or "
            "pass --overwrite to replace what is there."
        )
    with tempfile.TemporaryDirectory(prefix="sermon-restore-") as tmp:
        fetched = Path(tmp) / "download"
        store.get(key, fetched)
        dump_file = fetched
        if key.endswith(".enc"):
            if not passphrase:
                raise BackupError("This backup is encrypted. Set BACKUP_PASSPHRASE to restore it.")
            dump_file = Path(tmp) / "db.dump"
            decrypt_file(fetched, dump_file, passphrase)
        args = [
            _tool("pg_restore"),
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
            "--dbname",
            into_url,
        ]
        if overwrite:
            args[1:1] = ["--clean", "--if-exists"]
        result = subprocess.run([*args, str(dump_file)], capture_output=True, text=True)
        if result.returncode != 0:
            raise BackupError(f"pg_restore failed: {result.stderr.strip()[-300:]}")


# -- running it ---------------------------------------------------------------------------------


def seconds_until(hour: int, now: datetime) -> float:
    target = now.replace(hour=hour, minute=30, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def is_due(conn: psycopg.Connection, now: datetime | None = None) -> bool:
    """True when there has been no successful backup in the last 23 hours, so a freshly started
    service does not wait until the small hours to protect the data."""
    now = now or datetime.now().astimezone()
    row = conn.execute("SELECT value FROM settings WHERE key = 'backup_last'").fetchone()
    last = row["value"] if row else None
    if not last or not last.get("ok"):
        return True
    return now - datetime.fromisoformat(last["at"]) > timedelta(hours=23)


def backup_now(config: Config, store: BackupStore, passphrase: str | None) -> dict:
    with queue.connect(config.database_url) as conn:
        try:
            status = run_backup(config.database_url, store, passphrase)
        except (
            Exception
        ) as error:  # a failed backup must be visible, and must not stop the schedule
            status = {
                "ok": False,
                "at": datetime.now().astimezone().isoformat(),
                "error": str(error)[:300],
            }
        record(conn, status)
    return status


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="sermon_worker.backup")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("daemon", "run", "list"):
        sub.add_parser(name)
    restore_cmd = sub.add_parser("restore")
    restore_cmd.add_argument("key", help='a backup name from "list", or "latest"')
    restore_cmd.add_argument("--into", required=True, help="URL of the database to restore into")
    restore_cmd.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    load_env_file(REPO_ROOT / ".env.local")
    try:
        config = from_env()
    except ConfigError as error:
        print(f"Configuration problem: {error}", file=sys.stderr)
        return 2
    store = make_store(config)
    passphrase = os.environ.get("BACKUP_PASSPHRASE") or None

    try:
        if args.command == "list":
            for key in store.list():
                print(key)
            return 0
        if args.command == "restore":
            restore(store, args.key, args.into, passphrase, overwrite=args.overwrite)
            print("Restored.")
            return 0
        if args.command == "run":
            status = backup_now(config, store, passphrase)
            print(status)
            return 0 if status["ok"] else 1
        hour = int(os.environ.get("BACKUP_HOUR", "2"))
        print(
            f"Database backups every night at {hour:02d}:30, kept 14 days daily and 8 weeks weekly.",
            flush=True,
        )
        with queue.connect(config.database_url) as conn:
            due = is_due(conn)
        if due:
            print(backup_now(config, store, passphrase), flush=True)
        while True:
            time.sleep(seconds_until(hour, datetime.now().astimezone()))
            print(backup_now(config, store, passphrase), flush=True)
    except BackupError as error:
        print(f"Backup problem: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
