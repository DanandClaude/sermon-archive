"""Nightly database backups: what is kept, encryption, and restoring into a blank database."""

from __future__ import annotations

import shutil
from datetime import UTC, date, datetime, timedelta

import psycopg
import pytest
from conftest import make_sermon

from sermon_worker import backup
from sermon_worker.backup import (
    BackupError,
    LocalBackupStore,
    backup_key,
    decrypt_file,
    encrypt_file,
    latest,
    parse_key,
    run_backup,
    seconds_until,
    to_delete,
)

needs_postgres_tools = pytest.mark.skipif(
    not (shutil.which("pg_dump") and shutil.which("pg_restore")),
    reason="pg_dump and pg_restore are needed",
)

SUNDAY = date(2026, 9, 20)  # a Sunday
assert SUNDAY.weekday() == 6


def key(kind: str, day: date, enc: bool = False) -> str:
    return backup_key(kind, day, enc)


class TestNamesAndRetention:
    def test_names_are_predictable(self):
        assert key("daily", date(2026, 9, 20)) == "db-backups/daily/sermon-archive-2026-09-20.dump"
        assert (
            key("weekly", date(2026, 9, 20), True)
            == "db-backups/weekly/sermon-archive-2026-09-20.dump.enc"
        )
        assert parse_key(key("daily", date(2026, 9, 20), True)).day == date(2026, 9, 20)

    @pytest.mark.parametrize(
        "name",
        ["uploads/originals/x.mp3", "db-backups/x.dump", "db-backups/daily/notes.txt",
         "db-backups/daily/sermon-archive-2026-13-40.dump", "db-backups/monthly/sermon-archive-2026-09-20.dump"],
    )  # fmt: skip
    def test_anything_else_is_not_ours(self, name):
        assert parse_key(name) is None

    def test_keeps_fourteen_days_of_daily_backups(self):
        keys = [key("daily", SUNDAY - timedelta(days=n)) for n in range(0, 20)]
        gone = {parse_key(k).day for k in to_delete(keys, SUNDAY)}
        assert gone == {SUNDAY - timedelta(days=n) for n in range(15, 20)}
        assert key("daily", SUNDAY - timedelta(days=14)) not in to_delete(keys, SUNDAY)

    def test_keeps_eight_weeks_of_weekly_backups(self):
        keys = [key("weekly", SUNDAY - timedelta(weeks=n)) for n in range(0, 12)]
        kept = {parse_key(k).day for k in keys} - {
            parse_key(k).day for k in to_delete(keys, SUNDAY)
        }
        assert kept == {
            SUNDAY - timedelta(weeks=n) for n in range(0, 9)
        }  # 56 days back is still kept
        assert SUNDAY - timedelta(weeks=9) in {parse_key(k).day for k in to_delete(keys, SUNDAY)}

    def test_a_weekly_copy_outlives_the_daily_one_it_came_from(self):
        old = SUNDAY - timedelta(days=28)
        keys = [key("daily", old), key("weekly", old), key("daily", SUNDAY)]
        assert to_delete(keys, SUNDAY) == [key("daily", old)]

    def test_never_deletes_the_newest_backup_even_when_it_is_old(self):
        keys = [key("daily", date(2026, 1, 1)), key("weekly", date(2026, 1, 4))]
        assert to_delete(keys, SUNDAY) == []

    def test_leaves_alone_anything_that_is_not_a_backup(self):
        keys = [
            "uploads/originals/a.mp3",
            "db-backups/README.txt",
            key("daily", date(2020, 1, 1)),
            key("daily", SUNDAY),
        ]
        assert to_delete(keys, SUNDAY) == [key("daily", date(2020, 1, 1))]

    def test_latest_picks_the_newest_daily(self):
        keys = [
            key("daily", date(2026, 9, 1)),
            key("daily", date(2026, 9, 18)),
            key("weekly", date(2026, 9, 20)),
        ]
        assert latest(keys) == key("daily", date(2026, 9, 18))
        with pytest.raises(BackupError, match="no backups"):
            latest([])


class TestStore:
    def test_refuses_to_write_read_or_delete_anything_outside_its_own_names(self, tmp_path):
        store = LocalBackupStore(tmp_path / "b")
        victim = tmp_path / "b" / "uploads" / "originals" / "tape.mp3"
        victim.parent.mkdir(parents=True)
        victim.write_bytes(b"precious")
        src = tmp_path / "x"
        src.write_bytes(b"1")
        for call in (lambda: store.delete("uploads/originals/tape.mp3"), lambda: store.put("../escape", src),
                     lambda: store.get("uploads/originals/tape.mp3", src)):  # fmt: skip
            with pytest.raises(BackupError):
                call()
        assert victim.read_bytes() == b"precious"

    def test_lists_only_backups(self, tmp_path):
        store = LocalBackupStore(tmp_path)
        src = tmp_path / "s"
        src.write_bytes(b"1")
        store.put(key("daily", SUNDAY), src)
        (tmp_path / "other.txt").write_text("x")
        assert store.list() == [key("daily", SUNDAY)]


class TestEncryption:
    def test_round_trips_and_hides_the_contents(self, tmp_path):
        plain, sealed, back = tmp_path / "p", tmp_path / "s", tmp_path / "b"
        plain.write_bytes(b"people, emails and transcripts" * 100)
        encrypt_file(plain, sealed, "correct horse battery staple")
        assert b"transcripts" not in sealed.read_bytes()
        decrypt_file(sealed, back, "correct horse battery staple")
        assert back.read_bytes() == plain.read_bytes()

    def test_wrong_passphrase_or_damage_is_refused(self, tmp_path):
        plain, sealed = tmp_path / "p", tmp_path / "s"
        plain.write_bytes(b"data")
        encrypt_file(plain, sealed, "right")
        with pytest.raises(BackupError, match="Wrong passphrase"):
            decrypt_file(sealed, tmp_path / "o", "wrong")
        blob = bytearray(sealed.read_bytes())
        blob[-1] ^= 1
        sealed.write_bytes(bytes(blob))
        with pytest.raises(BackupError):
            decrypt_file(sealed, tmp_path / "o", "right")
        with pytest.raises(BackupError, match="not an encrypted"):
            decrypt_file(plain, tmp_path / "o", "right")

    def test_the_same_data_encrypts_differently_each_time(self, tmp_path):
        plain = tmp_path / "p"
        plain.write_bytes(b"data")
        encrypt_file(plain, tmp_path / "a", "x")
        encrypt_file(plain, tmp_path / "b", "x")
        assert (tmp_path / "a").read_bytes() != (tmp_path / "b").read_bytes()


def scratch_url(db_url: str, name: str) -> str:
    return db_url.rsplit("/", 1)[0] + "/" + name


@pytest.fixture()
def scratch(db_url):
    """An empty database to restore into, removed afterwards."""
    name = "sermon_archive_restore_test"
    admin = db_url.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}"')
        c.execute(f'CREATE DATABASE "{name}"')
    yield scratch_url(db_url, name)
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def count(url: str, table: str) -> int:
    with psycopg.connect(url) as c:
        return c.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


@needs_postgres_tools
class TestBackupAndRestore:
    def test_a_backup_restores_into_a_blank_database_with_the_data_intact(
        self, conn, db_url, scratch, tmp_path
    ):
        s = make_sermon(conn, "approved")
        conn.execute("UPDATE sermons SET title = 'Submitting to Leaders' WHERE id = %s", (s,))
        store = LocalBackupStore(tmp_path / "b")
        status = run_backup(db_url, store, None, datetime(2026, 9, 21, 2, 30, tzinfo=UTC))
        assert status["ok"] and status["bytes"] > 0 and not status["encrypted"]
        backup.restore(store, "latest", scratch, None)
        with psycopg.connect(scratch) as c:
            assert c.execute("SELECT title FROM sermons").fetchone()[0] == "Submitting to Leaders"
        assert count(scratch, "users") == count(db_url, "users") == 1

    def test_an_encrypted_backup_needs_its_passphrase_to_restore(
        self, conn, db_url, scratch, tmp_path
    ):
        make_sermon(conn, "approved")
        store = LocalBackupStore(tmp_path / "b")
        status = run_backup(
            db_url, store, "s3cret phrase", datetime(2026, 9, 21, 2, 30, tzinfo=UTC)
        )
        assert status["encrypted"] and status["key"].endswith(".dump.enc")
        assert b"PGDMP" not in (tmp_path / "b" / status["key"]).read_bytes()[:64]
        with pytest.raises(BackupError, match="encrypted"):
            backup.restore(store, "latest", scratch, None)
        with pytest.raises(BackupError, match="Wrong passphrase"):
            backup.restore(store, "latest", scratch, "nope")
        backup.restore(store, "latest", scratch, "s3cret phrase")
        assert count(scratch, "sermons") == 1

    def test_restore_refuses_a_database_that_already_has_data_unless_told_to(
        self, conn, db_url, scratch, tmp_path
    ):
        make_sermon(conn, "approved")
        store = LocalBackupStore(tmp_path / "b")
        run_backup(db_url, store, None, datetime(2026, 9, 21, 2, 30, tzinfo=UTC))
        backup.restore(store, "latest", scratch, None)
        with pytest.raises(BackupError, match="already has"):
            backup.restore(store, "latest", scratch, None)
        with psycopg.connect(scratch, autocommit=True) as c:
            c.execute("DELETE FROM sermons")
        backup.restore(store, "latest", scratch, None, overwrite=True)
        assert count(scratch, "sermons") == 1

    def test_sunday_also_makes_a_weekly_copy_and_other_days_do_not(self, conn, db_url, tmp_path):
        store = LocalBackupStore(tmp_path / "b")
        sunday = run_backup(db_url, store, None, datetime(2026, 9, 20, 2, 30, tzinfo=UTC))
        monday = run_backup(db_url, store, None, datetime(2026, 9, 21, 2, 30, tzinfo=UTC))
        assert sunday["weekly"] and not monday["weekly"]
        assert store.list() == [
            key("daily", date(2026, 9, 20)), key("daily", date(2026, 9, 21)), key("weekly", date(2026, 9, 20)),
        ]  # fmt: skip

    def test_each_run_prunes_what_is_out_of_date(self, conn, db_url, tmp_path):
        store = LocalBackupStore(tmp_path / "b")
        stub = tmp_path / "stub"
        stub.write_bytes(b"old")
        for k in (key("daily", date(2026, 8, 1)), key("daily", date(2026, 9, 10)), key("weekly", date(2026, 6, 7)),
                  key("weekly", date(2026, 8, 30))):  # fmt: skip
            store.put(k, stub)
        status = run_backup(db_url, store, None, datetime(2026, 9, 20, 2, 30, tzinfo=UTC))
        assert status["removed"] == 2
        assert key("daily", date(2026, 8, 1)) not in store.list()
        assert key("weekly", date(2026, 6, 7)) not in store.list()
        assert (
            key("daily", date(2026, 9, 10)) in store.list()
            and key("weekly", date(2026, 8, 30)) in store.list()
        )

    def test_a_backup_of_a_missing_database_fails_loudly_and_writes_nothing(self, tmp_path):
        store = LocalBackupStore(tmp_path / "b")
        with pytest.raises(BackupError, match="pg_dump failed"):
            run_backup("postgres://localhost:5432/no_such_database_here", store, None)
        assert store.list() == []


@needs_postgres_tools
class TestStatusAndSchedule:
    def config(self, db_url, tmp_path):
        from dataclasses import replace

        from sermon_worker.config import Config

        return replace(
            Config(database_url=db_url, transcriber="fake"), data_dir=tmp_path / "data" / "uploads"
        )

    def test_records_a_good_run_where_the_app_can_show_it(self, conn, db_url, tmp_path):
        status = backup.backup_now(
            self.config(db_url, tmp_path), LocalBackupStore(tmp_path / "b"), None
        )
        assert status["ok"]
        saved = conn.execute("SELECT value FROM settings WHERE key = 'backup_last'").fetchone()[
            "value"
        ]
        assert saved["ok"] is True and saved["key"].startswith("db-backups/daily/")

    def test_records_a_failed_run_too_and_carries_on(self, conn, db_url, tmp_path):
        class Broken(LocalBackupStore):
            def put(self, key, src):
                raise OSError("disk full")

        status = backup.backup_now(self.config(db_url, tmp_path), Broken(tmp_path / "b"), None)
        assert status["ok"] is False and "disk full" in status["error"]
        assert (
            conn.execute("SELECT value FROM settings WHERE key = 'backup_last'").fetchone()[
                "value"
            ]["ok"]
            is False
        )

    def test_a_new_service_backs_up_at_once_if_nothing_recent_exists(self, conn):
        now = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)
        assert backup.is_due(conn, now) is True
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('backup_last', %s::jsonb)",
            (f'{{"ok": true, "at": "{(now - timedelta(hours=3)).isoformat()}"}}',),
        )
        assert backup.is_due(conn, now) is False
        assert backup.is_due(conn, now + timedelta(hours=21)) is True
        conn.execute(
            'UPDATE settings SET value = \'{"ok": false, "at": "2026-09-21T11:00:00+00:00"}\'::jsonb'
        )
        assert backup.is_due(conn, now) is True


def test_waits_until_the_next_half_past_the_hour():
    at = datetime(2026, 9, 20, 1, 0, tzinfo=UTC)
    assert seconds_until(2, at) == 90 * 60
    assert seconds_until(2, datetime(2026, 9, 20, 2, 30, tzinfo=UTC)) == 24 * 3600
    assert seconds_until(2, datetime(2026, 9, 20, 5, 0, tzinfo=UTC)) == 21.5 * 3600
