"""Filing an approved sermon to the shared drive and the backup, and checking it stays intact."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import date, datetime
from pathlib import Path

import pytest
from conftest import add_job, add_target, job_row, make_sermon, sermon_row
from test_analysis import segments_from
from test_runner import Scripted as ScriptedTranscriber

from sermon_worker import queue, verify
from sermon_worker.analysis import FakeAnalyzer
from sermon_worker.providers import LocalDiskProvider, StorageError
from sermon_worker.render import to_srt, to_text
from sermon_worker.runner import Runner

STEM = "1988-03-13_Hebrews-13-17_Submitting-to-Leaders"
FOLDER = f"1980s/1988/{STEM}"
ORIGINAL = b"RIFF....original tape audio bytes...."
CLEANED = b"ID3....cleaned audio bytes...."
TEXT = "Turn with me to Hebrews 13:17. Obey them that have the rule over you. @30 Let us pray."


def make_runner(conn, config, store) -> Runner:
    return Runner(conn, config, store, ScriptedTranscriber(), analyzer=FakeAnalyzer())


@pytest.fixture()
def roots(tmp_path) -> dict[str, Path]:
    return {"shared": tmp_path / "shared", "backup": tmp_path / "backup"}


@pytest.fixture()
def connected(conn, roots):
    return {role: add_target(conn, role, folder) for role, folder in roots.items()}


def put_object(store, key: str, data: bytes) -> None:
    target = store.root / "objects" / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


@pytest.fixture()
def approved(conn, store) -> str:
    """An approved sermon with its audio, transcript, passage, tags and file name, waiting to be filed."""
    sermon = make_sermon(conn, "approved", speaker="Pastor Lee")
    conn.execute(
        "UPDATE sermons SET title = 'Submitting to Leaders', recorded_on = '1988-03-13', filename_stem = %s, "
        "summary_text = 'A summary.', summary_source = 'auto', duration_sec = 2700, approved_at = now(), "
        "primary_passage = %s WHERE id = %s",
        (STEM, json.dumps({"book": "Hebrews", "chapter": 13, "verseStart": 17, "verseEnd": None}), sermon),
    )  # fmt: skip
    for kind, key, data, mime in (
        ("original", f"originals/{sermon}/original.wav", ORIGINAL, "audio/wav"),
        ("cleaned", f"cleaned/{sermon}/job.mp3", CLEANED, "audio/mpeg"),
    ):
        put_object(store, key, data)
        conn.execute(
            "INSERT INTO audio_assets (sermon_id, kind, storage_key, sha256, bytes, mime, original_filename) "
            "VALUES (%s, %s::audio_kind, %s, 'x', %s, %s, 'f')",
            (sermon, kind, key, len(data), mime),
        )
    conn.execute(
        "INSERT INTO transcripts (sermon_id, version, model, language, full_text, segments, low_confidence) "
        "VALUES (%s, 1, 'test', 'en', %s, %s, '[]')",
        (sermon, TEXT, json.dumps(segments_from(TEXT))),
    )
    conn.execute(
        "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, spoken_at_sec, context_note, "
        "is_main_text, source) VALUES (%s, 'Hebrews', 13, 17, 3.5, 'Obey them', true, 'auto')",
        (sermon,),
    )
    tag = conn.execute(
        "INSERT INTO tags (kind, name) VALUES ('book', 'Hebrews') RETURNING id"
    ).fetchone()["id"]
    conn.execute("INSERT INTO sermon_tags (sermon_id, tag_id) VALUES (%s, %s)", (sermon, tag))
    return sermon


def objects(conn):
    return conn.execute(
        "SELECT t.role, o.path, o.kind, o.state, o.sha256, o.remote_checksum FROM storage_objects o "
        "JOIN storage_targets t ON t.id = o.target_id ORDER BY t.role, o.path"
    ).fetchall()


def run_file(conn, config, store, sermon) -> str:
    job = add_job(conn, sermon, "file")
    make_runner(conn, config, store).run_once()
    return job


class TestFiling:
    def test_files_both_targets_and_marks_the_sermon_filed(
        self, conn, config, store, roots, connected, approved
    ):
        job = run_file(conn, config, store, approved)
        s = sermon_row(conn, approved)
        assert (s["status"], s["filing_error"]) == ("filed", None)
        assert s["filed_at"] is not None
        assert job_row(conn, job)["state"] == "succeeded"
        shared = sorted(p.name for p in (roots["shared"] / FOLDER).iterdir())
        backup = sorted(p.name for p in (roots["backup"] / FOLDER).iterdir())
        assert shared == [f"{STEM}.json", f"{STEM}.mp3", f"{STEM}.srt", f"{STEM}.txt"]
        assert backup == [
            f"{STEM}.json", f"{STEM}.mp3", f"{STEM}.srt", f"{STEM}.txt",
            f"{STEM}_original.wav", f"{STEM}_transcript.json",
        ]  # fmt: skip

    def test_the_shared_drive_gets_no_original_and_no_word_timings(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        names = {p.name for p in (roots["shared"] / FOLDER).iterdir()}
        assert not any("original" in n or "transcript.json" in n for n in names)

    def test_the_originals_are_filed_byte_for_byte(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        assert (roots["backup"] / FOLDER / f"{STEM}_original.wav").read_bytes() == ORIGINAL
        assert (roots["backup"] / FOLDER / f"{STEM}.mp3").read_bytes() == CLEANED
        assert (roots["shared"] / FOLDER / f"{STEM}.mp3").read_bytes() == CLEANED

    def test_text_and_subtitles_are_what_the_app_would_download(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        segments = segments_from(TEXT)
        assert (roots["shared"] / FOLDER / f"{STEM}.txt").read_text() == to_text(segments)
        assert (roots["shared"] / FOLDER / f"{STEM}.srt").read_text() == to_srt(segments)

    def test_the_metadata_has_the_title_date_summary_passages_and_tags(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        meta = json.loads((roots["shared"] / FOLDER / f"{STEM}.json").read_text())
        assert meta["title"] == "Submitting to Leaders"
        assert (meta["recordedOn"], meta["fileStem"], meta["speaker"]) == (
            "1988-03-13",
            STEM,
            "Pastor Lee",
        )
        assert meta["summary"] == "A summary." and meta["durationSec"] == 2700
        assert meta["primaryPassage"]["text"] == "Hebrews 13:17"
        assert meta["passages"] == [
            {"book": "Hebrews", "chapter": 13, "verseStart": 17, "verseEnd": None, "text": "Hebrews 13:17",
             "spokenAtSec": 3.5, "contextNote": "Obey them", "isMainText": True}
        ]  # fmt: skip
        assert meta["tags"] == [{"kind": "book", "name": "Hebrews"}]
        assert meta["transcript"] == {"model": "test", "language": "en", "version": 1}

    def test_the_backup_transcript_keeps_every_word_timing(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        data = json.loads((roots["backup"] / FOLDER / f"{STEM}_transcript.json").read_text())
        assert data["segments"] == json.loads(json.dumps(segments_from(TEXT)))
        assert data["segments"][0]["words"][0]["w"] == "Turn"

    def test_deleted_passages_are_left_out(self, conn, config, store, roots, connected, approved):
        conn.execute(
            "UPDATE scripture_refs SET deleted_at = now() WHERE sermon_id = %s", (approved,)
        )
        run_file(conn, config, store, approved)
        meta = json.loads((roots["shared"] / FOLDER / f"{STEM}.json").read_text())
        assert meta["passages"] == []

    def test_records_every_file_with_our_hash_and_the_providers(
        self, conn, config, store, roots, connected, approved
    ):
        run_file(conn, config, store, approved)
        rows = objects(conn)
        assert len(rows) == 10 and {r["state"] for r in rows} == {"verified"}
        original = next(r for r in rows if r["kind"] == "audio_original")
        assert original["role"] == "backup"
        assert original["sha256"] == hashlib.sha256(ORIGINAL).hexdigest()
        assert original["remote_checksum"] == hashlib.md5(ORIGINAL).hexdigest()
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM storage_objects WHERE verified_at IS NULL"
            ).fetchone()["n"]
            == 0
        )

    def test_says_so_in_the_audit_log(self, conn, config, store, connected, approved):
        run_file(conn, config, store, approved)
        entry = conn.execute("SELECT * FROM audit_log WHERE action = 'sermon.filed'").fetchone()
        assert (
            entry["actor_id"] is None
            and entry["entity_id"] == approved
            and entry["diff"] == {"files": 10}
        )

    def test_filing_twice_writes_nothing_new(self, conn, config, store, roots, connected, approved):
        run_file(conn, config, store, approved)
        before = {p: p.stat().st_mtime_ns for p in roots["backup"].rglob("*") if p.is_file()}
        conn.execute(
            "UPDATE sermons SET status = 'approved', filed_at = NULL WHERE id = %s", (approved,)
        )
        run_file(conn, config, store, approved)
        after = {p: p.stat().st_mtime_ns for p in roots["backup"].rglob("*") if p.is_file()}
        assert before == after and len(objects(conn)) == 10
        assert sermon_row(conn, approved)["status"] == "filed"


class TestFilingFails:
    def test_without_both_targets_the_sermon_stays_approved_with_a_plain_reason(
        self, conn, config, store, roots, approved
    ):
        add_target(conn, "shared", roots["shared"])
        job = run_file(conn, config, store, approved)
        s = sermon_row(conn, approved)
        assert s["status"] == "approved" and "Connections page" in s["filing_error"]
        assert s["filed_at"] is None and s["failed_stage"] is None
        assert job_row(conn, job)["state"] == "failed" and job_row(conn, job)["attempts"] == 1
        assert objects(conn) == []

    def test_a_disconnected_target_counts_as_missing(
        self, conn, config, store, connected, approved
    ):
        conn.execute(
            "UPDATE storage_targets SET encrypted_config = NULL, disconnected_at = now() WHERE role = 'backup'"
        )
        run_file(conn, config, store, approved)
        assert sermon_row(conn, approved)["status"] == "approved"
        assert not any(True for _ in (conn.execute("SELECT 1 FROM storage_objects").fetchall()))

    def test_a_backup_failure_after_the_shared_copy_is_never_reported_as_filed(
        self, conn, config, store, roots, connected, approved, monkeypatch
    ):
        real_put = LocalDiskProvider.put

        def put(self, path, source, content_type):
            if self.root == roots["backup"]:
                raise StorageError("The backup drive is unreachable.")
            return real_put(self, path, source, content_type)

        monkeypatch.setattr(LocalDiskProvider, "put", put)
        job = run_file(conn, config, store, approved)
        s = sermon_row(conn, approved)
        assert s["status"] == "filing" and s["filed_at"] is None  # waiting to retry
        assert (
            job_row(conn, job)["state"] == "queued"
            and "unreachable" in job_row(conn, job)["last_error"]
        )
        assert (roots["shared"] / FOLDER).exists() and not (roots["backup"] / FOLDER).exists()

    def test_after_the_last_attempt_it_returns_to_approved_with_the_reason(
        self, conn, config, store, connected, approved, monkeypatch
    ):
        monkeypatch.setattr(
            LocalDiskProvider,
            "put",
            lambda *a, **k: (_ for _ in ()).throw(StorageError("Drive is busy.")),
        )
        job = add_job(conn, approved, "file", attempts=2)
        make_runner(conn, config, store).run_once()
        s = sermon_row(conn, approved)
        assert (s["status"], s["filing_error"]) == ("approved", "Drive is busy.")
        assert job_row(conn, job)["state"] == "failed"

    def test_a_retry_after_a_partial_failure_finishes_without_touching_what_was_filed(
        self, conn, config, store, roots, connected, approved, monkeypatch
    ):
        real_put = LocalDiskProvider.put
        calls = {"n": 0}

        def flaky(self, path, source, content_type):
            calls["n"] += 1
            if calls["n"] == 6:  # the backup's second file
                raise StorageError("dropped")
            return real_put(self, path, source, content_type)

        monkeypatch.setattr(LocalDiskProvider, "put", flaky)
        job = run_file(conn, config, store, approved)
        assert job_row(conn, job)["state"] == "queued"
        first = {p: p.stat().st_mtime_ns for p in roots["shared"].rglob("*") if p.is_file()}
        conn.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job,))
        make_runner(conn, config, store).run_once()
        assert sermon_row(conn, approved)["status"] == "filed"
        assert len(objects(conn)) == 10
        assert first == {p: p.stat().st_mtime_ns for p in roots["shared"].rglob("*") if p.is_file()}

    def test_a_different_file_already_at_the_path_stops_filing_and_is_left_alone(
        self, conn, config, store, roots, connected, approved
    ):
        squatter = roots["shared"] / FOLDER / f"{STEM}.mp3"
        squatter.parent.mkdir(parents=True)
        squatter.write_bytes(b"someone else's file")
        job = run_file(conn, config, store, approved)
        s = sermon_row(conn, approved)
        assert s["status"] == "approved" and "nothing is overwritten" in s["filing_error"]
        assert job_row(conn, job)["state"] == "failed" and job_row(conn, job)["attempts"] == 1
        assert squatter.read_bytes() == b"someone else's file"

    def test_an_identical_file_already_there_is_adopted(
        self, conn, config, store, roots, connected, approved
    ):
        existing = roots["shared"] / FOLDER / f"{STEM}.mp3"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(CLEANED)
        run_file(conn, config, store, approved)
        assert sermon_row(conn, approved)["status"] == "filed"
        assert any(
            r["path"] == f"{FOLDER}/{STEM}.mp3" and r["role"] == "shared" for r in objects(conn)
        )

    def test_a_file_that_changes_right_after_it_is_written_is_caught_before_filed(
        self, conn, config, store, roots, connected, approved, monkeypatch
    ):
        real_put = LocalDiskProvider.put

        def corrupting(self, path, source, content_type):
            stored = real_put(self, path, source, content_type)
            if path.endswith(".srt") and self.root == roots["backup"]:
                (self.root / path).write_bytes(b"corrupted")
            return stored

        monkeypatch.setattr(LocalDiskProvider, "put", corrupting)
        run_file(conn, config, store, approved)
        s = sermon_row(conn, approved)
        assert s["status"] == "filing" and s["filed_at"] is None
        assert [
            r["state"]
            for r in objects(conn)
            if r["path"].endswith(".srt") and r["role"] == "backup"
        ] == ["drifted"]

    @pytest.mark.parametrize(
        "sql",
        [
            "UPDATE sermons SET filename_stem = NULL WHERE id = %s",
            "UPDATE sermons SET recorded_on = NULL WHERE id = %s",
            "DELETE FROM transcripts WHERE sermon_id = %s",
            "DELETE FROM audio_assets WHERE sermon_id = %s AND kind = 'cleaned'",
            "DELETE FROM audio_assets WHERE sermon_id = %s AND kind = 'original'",
        ],
    )
    def test_a_sermon_missing_something_essential_fails_at_once(
        self, conn, config, store, connected, approved, sql
    ):
        conn.execute(sql, (approved,))
        job = run_file(conn, config, store, approved)
        assert (
            sermon_row(conn, approved)["status"] == "approved"
            and sermon_row(conn, approved)["filing_error"]
        )
        assert job_row(conn, job)["attempts"] == 1 and job_row(conn, job)["state"] == "failed"

    def test_google_drive_is_refused_outside_production_mode(
        self, conn, config, store, roots, approved
    ):
        add_target(
            conn,
            "shared",
            None,
            kind="google_drive",
            account="a@example.org",
            config={"kind": "google_drive", "refreshToken": "r"},
        )
        add_target(conn, "backup", roots["backup"])
        run_file(conn, config, store, approved)
        assert (
            "only used when the app runs in production mode"
            in sermon_row(conn, approved)["filing_error"]
        )
        assert not roots["backup"].exists()

    def test_a_development_folder_is_refused_in_production(
        self, conn, config, store, connected, approved
    ):
        production = replace(config, node_env="production", secrets_key="ab" * 32)
        run_file(conn, production, store, approved)
        assert sermon_row(conn, approved)["status"] == "approved"

    def test_unreadable_credentials_ask_for_a_reconnect(
        self, conn, config, store, connected, approved
    ):
        conn.execute(
            "UPDATE storage_targets SET encrypted_config = 'v1.a.b.c' WHERE role = 'shared'"
        )
        run_file(conn, config, store, approved)
        assert "Reconnect" in sermon_row(conn, approved)["filing_error"]

    def test_a_new_attempt_clears_the_old_reason(self, conn, config, store, connected, approved):
        conn.execute("UPDATE sermons SET filing_error = 'Old problem.' WHERE id = %s", (approved,))
        run_file(conn, config, store, approved)
        assert sermon_row(conn, approved)["filing_error"] is None

    def test_a_sermon_deleted_while_filing_is_not_marked_filed(
        self, conn, config, store, connected, approved
    ):
        add_job(conn, approved, "file")
        conn.execute("UPDATE sermons SET deleted_at = now() WHERE id = %s", (approved,))
        make_runner(conn, config, store).run_once()
        assert sermon_row(conn, approved)["status"] == "approved"
        assert objects(conn) == []


class TestReconcile:
    def test_queues_filing_for_an_approved_sermon_that_never_had_a_job(self, conn, approved):
        assert queue.reconcile_filing(conn) == 1
        assert queue.reconcile_filing(conn) == 0

    def test_leaves_a_sermon_alone_that_already_had_its_turn(self, conn, approved):
        conn.execute(
            "INSERT INTO jobs (sermon_id, type, state) VALUES (%s, 'file', 'failed')", (approved,)
        )
        assert queue.reconcile_filing(conn) == 0

    def test_only_approved_live_sermons(self, conn):
        make_sermon(conn, "needs_review")
        make_sermon(conn, "filed")
        make_sermon(conn, "approved", deleted=True)
        assert queue.reconcile_filing(conn) == 0


class TestVerification:
    def filed(self, conn, config, store, approved):
        run_file(conn, config, store, approved)
        return conn.execute(
            "INSERT INTO verification_runs (trigger) VALUES ('manual') RETURNING id"
        ).fetchone()["id"]

    def run(self, conn, config, run_id):
        assert verify.claim_run(conn) == str(run_id)
        return verify.run_verification(conn, config, str(run_id))

    def test_everything_intact_is_verified(self, conn, config, store, connected, approved):
        run_id = self.filed(conn, config, store, approved)
        result = self.run(conn, config, run_id)
        assert result == {"checked": 10, "verified": 10, "drifted": 0, "missing": 0, "error": None}
        row = conn.execute("SELECT * FROM verification_runs WHERE id = %s", (run_id,)).fetchone()
        assert (row["state"], row["checked"], row["verified"]) == ("done", 10, 10) and row[
            "finished_at"
        ]
        assert all(
            t["last_verified_at"]
            for t in conn.execute("SELECT last_verified_at FROM storage_targets").fetchall()
        )
        assert (
            conn.execute("SELECT diff FROM audit_log WHERE action = 'storage.verified'").fetchone()[
                "diff"
            ]["checked"]
            == 10
        )

    def test_a_changed_file_is_drift_and_a_removed_one_is_missing(
        self, conn, config, store, roots, connected, approved
    ):
        run_id = self.filed(conn, config, store, approved)
        (roots["shared"] / FOLDER / f"{STEM}.txt").write_text("edited by someone")
        (roots["backup"] / FOLDER / f"{STEM}_original.wav").unlink()
        result = self.run(conn, config, run_id)
        assert (result["drifted"], result["missing"], result["verified"]) == (1, 1, 8)
        states = {(r["role"], r["path"].split("/")[-1]): r["state"] for r in objects(conn)}
        assert states[("shared", f"{STEM}.txt")] == "drifted"
        assert states[("backup", f"{STEM}_original.wav")] == "missing"

    def test_a_file_put_back_is_verified_again(
        self, conn, config, store, roots, connected, approved
    ):
        run_id = self.filed(conn, config, store, approved)
        path = roots["shared"] / FOLDER / f"{STEM}.txt"
        original = path.read_bytes()
        path.write_text("edited")
        self.run(conn, config, run_id)
        path.write_bytes(original)
        second = conn.execute(
            "INSERT INTO verification_runs (trigger) VALUES ('manual') RETURNING id"
        ).fetchone()["id"]
        assert self.run(conn, config, second)["drifted"] == 0

    def test_a_disconnected_target_is_skipped_not_reported_as_missing(
        self, conn, config, store, connected, approved
    ):
        run_id = self.filed(conn, config, store, approved)
        conn.execute(
            "UPDATE storage_targets SET encrypted_config = NULL, disconnected_at = now() WHERE role = 'backup'"
        )
        result = self.run(conn, config, run_id)
        assert (result["checked"], result["missing"]) == (4, 0)

    def test_a_target_that_cannot_be_reached_is_reported_and_the_other_still_checked(
        self, conn, config, store, roots, connected, approved, monkeypatch
    ):
        run_id = self.filed(conn, config, store, approved)
        real = LocalDiskProvider.stat

        def stat(self, path):
            if self.root == roots["backup"]:
                raise StorageError("no route to the backup")
            return real(self, path)

        monkeypatch.setattr(LocalDiskProvider, "stat", stat)
        result = self.run(conn, config, run_id)
        assert result["checked"] == 4 and "backup could not be checked" in result["error"]
        assert (
            conn.execute("SELECT state FROM verification_runs WHERE id = %s", (run_id,)).fetchone()[
                "state"
            ]
            == "failed"
        )

    def test_unreadable_credentials_fail_the_run_with_a_reason(
        self, conn, config, store, connected, approved
    ):
        run_id = self.filed(conn, config, store, approved)
        conn.execute(
            "UPDATE storage_targets SET encrypted_config = 'v1.a.b.c' WHERE role = 'shared'"
        )
        result = self.run(conn, config, run_id)
        assert "Reconnect" in result["error"]

    def test_the_runner_picks_up_a_queued_run_when_no_jobs_are_waiting(
        self, conn, config, store, connected, approved
    ):
        run_file(conn, config, store, approved)
        conn.execute("INSERT INTO verification_runs (trigger) VALUES ('manual')")
        runner = make_runner(conn, config, store)
        assert runner.run_once() is True
        assert conn.execute("SELECT state FROM verification_runs").fetchone()["state"] == "done"
        assert runner.run_once() is False

    def test_two_workers_never_take_the_same_run(self, conn):
        conn.execute("INSERT INTO verification_runs (trigger) VALUES ('manual')")
        assert verify.claim_run(conn) is not None
        assert verify.claim_run(conn) is None

    def test_a_run_abandoned_by_a_crashed_worker_is_failed(self, conn):
        conn.execute(
            "INSERT INTO verification_runs (trigger, state, started_at) VALUES ('manual', 'running', now() - interval '3 hours')"
        )
        assert verify.reap_stale_runs(conn) == 1
        assert conn.execute("SELECT state FROM verification_runs").fetchone()["state"] == "failed"


class TestNightly:
    def add_object(self, conn, sermon):
        target = add_target(conn, "shared", Path("/tmp/x"))
        conn.execute(
            "INSERT INTO storage_objects (sermon_id, target_id, kind, path, remote_id, bytes, sha256, remote_checksum, "
            "checksum_algorithm) VALUES (%s, %s, 'metadata', 'p', 'r', 1, 'x', 'y', 'md5')",
            (sermon, target),
        )

    def test_queues_one_check_a_day_after_three_in_the_morning(self, conn):
        self.add_object(conn, make_sermon(conn, "filed"))
        assert verify.ensure_nightly(conn, datetime(2026, 9, 19, 2, 59)) is False
        assert verify.ensure_nightly(conn, datetime(2026, 9, 19, 3, 0)) is True
        assert verify.ensure_nightly(conn, datetime(2026, 9, 19, 4, 0)) is False
        assert conn.execute("SELECT trigger, state FROM verification_runs").fetchall() == [
            {"trigger": "nightly", "state": "queued"}
        ]

    def test_does_nothing_when_nothing_has_been_filed(self, conn):
        assert verify.ensure_nightly(conn, datetime(2026, 9, 19, 4, 0)) is False

    def test_a_check_from_yesterday_does_not_stop_todays(self, conn):
        self.add_object(conn, make_sermon(conn, "filed"))
        conn.execute(
            "INSERT INTO verification_runs (trigger, state, created_at) VALUES ('nightly', 'done', now() - interval '25 hours')"
        )
        assert verify.ensure_nightly(conn, datetime(2026, 9, 20, 4, 0)) is True


def test_the_folder_layout_by_decade_and_year():
    from sermon_worker.filing import folder_for

    assert folder_for(date(1988, 3, 13), "s") == "1980s/1988/s"
    assert folder_for(date(1999, 12, 31), "s") == "1990s/1999/s"
    assert folder_for(date(2000, 1, 1), "s") == "2000s/2000/s"
