from __future__ import annotations

import hashlib
import json
from dataclasses import replace

import pytest
from conftest import (
    add_job,
    add_original,
    job_row,
    make_sermon,
    sermon_row,
)

from sermon_worker import queue
from sermon_worker.runner import Runner
from sermon_worker.transcribe import Segment, TranscriptResult, Word


class Scripted:
    """A transcriber that does what the test tells it to, and remembers how it was used."""

    name = "test:scripted"

    def __init__(self, text="Turn to Hebrews thirteen.", raises=None, on_call=None):
        self.text, self.raises, self.on_call = text, raises, on_call
        self.calls: list[dict] = []

    def transcribe(self, audio, *, prompt, on_progress):
        self.calls.append({"suffix": audio.suffix, "prompt": prompt, "size": audio.stat().st_size})
        if self.on_call:
            self.on_call()
        if self.raises:
            raise self.raises
        for fraction in (0.1, 0.5, 0.9):
            on_progress(fraction)
        words = [
            Word(w, i * 0.5, i * 0.5 + 0.4, 0.3 if i == 1 else 0.9)
            for i, w in enumerate(self.text.split())
        ]
        segments = [Segment(0.0, 5.0, self.text, words)] if self.text else []
        return TranscriptResult(segments, "en", self.name, 8.0)


class SpyStore:
    """Wraps a store and records what was downloaded and uploaded."""

    def __init__(self, inner):
        self.inner, self.downloads, self.uploads = inner, [], []

    def download(self, key, dest):
        self.downloads.append(key)
        return self.inner.download(key, dest)

    def upload(self, key, src, content_type):
        self.uploads.append(key)
        return self.inner.upload(key, src, content_type)

    def upload_bytes(self, key, data, content_type):
        self.uploads.append(key)
        return self.inner.upload_bytes(key, data, content_type)

    def exists(self, key):
        return self.inner.exists(key)


def make_runner(conn, config, store, transcriber=None, **kw) -> Runner:
    return Runner(conn, config, store, transcriber or Scripted(), **kw)


def run_until_idle(runner: Runner) -> int:
    n = 0
    while runner.run_once():
        n += 1
        assert n < 20, "the queue never drained"
    return n


def sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture()
def uploaded(conn, store, hummy_wav):
    """A sermon that has just finished uploading, with its cleanup job queued."""
    sermon = make_sermon(conn, "uploaded", speaker="Pastor Lee")
    key = add_original(conn, store, sermon, hummy_wav)
    job = add_job(conn, sermon, "clean")
    return sermon, key, job


class TestCleanJob:
    def test_makes_cleaned_audio_peaks_and_a_transcribe_job(
        self, conn, config, store, uploaded, hummy_wav
    ):
        sermon, key, job = uploaded
        original_path = store.root / "objects" / key
        before = sha(original_path)
        spy = SpyStore(store)
        assert make_runner(conn, config, spy).run_once() is True

        # cleaned audio recorded and stored under a key made from the job id
        cleaned = conn.execute("SELECT * FROM audio_assets WHERE kind = 'cleaned'").fetchone()
        assert cleaned["storage_key"] == f"cleaned/{sermon}/{job}.mp3"
        assert (
            (store.root / "objects" / cleaned["storage_key"]).stat().st_size
            == cleaned["bytes"]
            > 1000
        )
        assert cleaned["mime"] == "audio/mpeg" and cleaned["duration_sec"] == 8

        # peaks for both, drawn from the real audio
        for peaks_key in (cleaned["peaks_key"], f"peaks/{sermon}/original.json"):
            data = json.loads((store.root / "objects" / peaks_key).read_text())
            assert data["version"] == 1 and len(data["peaks"]) == 16 and max(data["peaks"]) > 0.02
        original = conn.execute("SELECT * FROM audio_assets WHERE kind = 'original'").fetchone()
        assert (
            original["peaks_key"] == f"peaks/{sermon}/original.json"
            and original["duration_sec"] == 8
        )

        # sermon and job bookkeeping, and the hand-off to transcription
        s = sermon_row(conn, sermon)
        assert (s["status"], s["duration_sec"]) == ("transcribing", 8)
        j = job_row(conn, job)
        assert (j["state"], j["progress"], j["attempts"]) == ("succeeded", 100, 1)
        nxt = conn.execute("SELECT * FROM jobs WHERE type = 'transcribe'").fetchone()
        assert nxt["state"] == "queued"

        # the original is untouched and the worker never wrote near it
        assert sha(original_path) == before
        assert not any(k.startswith("originals/") for k in spy.uploads)
        assert spy.downloads == [key]

    def test_progress_only_moves_forward_and_finishes_in_the_database(
        self, conn, config, store, uploaded, monkeypatch
    ):
        seen: list[int] = []
        real = queue.set_progress
        monkeypatch.setattr(queue, "set_progress", lambda c, j, p: (seen.append(p), real(c, j, p)))
        ticks = iter(range(0, 10_000, 5))  # the clock jumps 5s per call, so nothing is throttled
        make_runner(conn, config, store, clock=lambda: next(ticks)).run_once()
        assert seen and seen == sorted(seen) and seen[0] >= 2 and seen[-1] <= 100

    def test_running_it_again_after_a_crash_replaces_only_its_own_output(
        self, conn, config, store, uploaded
    ):
        sermon, key, job = uploaded
        make_runner(conn, config, store).run_once()
        # simulate the worker dying after uploading but before the job was recorded
        conn.execute("DELETE FROM audio_assets WHERE kind = 'cleaned'")
        conn.execute("UPDATE jobs SET state = 'queued' WHERE id = %s", (job,))
        conn.execute("DELETE FROM jobs WHERE type = 'transcribe'")
        conn.execute("UPDATE sermons SET status = 'cleaning' WHERE id = %s", (sermon,))
        make_runner(conn, config, store).run_once()
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM audio_assets WHERE kind = 'cleaned'"
            ).fetchone()["n"]
            == 1
        )
        assert sermon_row(conn, sermon)["status"] == "transcribing"

    def test_a_deleted_sermon_is_skipped_and_untouched(self, conn, config, store, uploaded):
        sermon, _, job = uploaded
        conn.execute("UPDATE sermons SET deleted_at = now() WHERE id = %s", (sermon,))
        make_runner(conn, config, store).run_once()
        assert job_row(conn, job)["state"] == "canceled"
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM audio_assets WHERE kind = 'cleaned'"
            ).fetchone()["n"]
            == 0
        )
        assert sermon_row(conn, sermon)["status"] == "uploaded"


class TestCleanFailures:
    def test_a_damaged_file_is_retried_then_fails_with_a_plain_message(
        self, conn, config, store, not_audio
    ):
        sermon = make_sermon(conn, "uploaded")
        add_original(conn, store, sermon, not_audio, "original.mp3")
        job = add_job(conn, sermon, "clean", max_attempts=2)
        runner = make_runner(conn, config, store)
        runner.run_once()
        assert job_row(conn, job)["state"] == "queued"  # attempt 1 failed; waiting to retry
        assert "MediaError" in job_row(conn, job)["last_error"]
        assert sermon_row(conn, sermon)["status"] == "cleaning"
        conn.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job,))
        runner.run_once()
        assert job_row(conn, job)["state"] == "failed"
        s = sermon_row(conn, sermon)
        assert (s["status"], s["failed_stage"]) == ("failed", "cleaning")
        assert s["last_error"] == "The audio file could not be processed. It may be damaged."

    def test_a_missing_original_in_storage_is_reported(self, conn, config, store):
        sermon = make_sermon(conn, "uploaded")
        add_original(conn, store, sermon, None)
        add_job(conn, sermon, "clean", max_attempts=1)
        make_runner(conn, config, store).run_once()
        assert (
            sermon_row(conn, sermon)["last_error"]
            == "The audio file could not be found in storage."
        )

    def test_a_sermon_with_no_uploaded_audio_fails_at_once(self, conn, config, store):
        sermon = make_sermon(conn, "uploaded")
        job = add_job(conn, sermon, "clean")
        make_runner(conn, config, store).run_once()
        assert job_row(conn, job)["state"] == "failed" and job_row(conn, job)["attempts"] == 1
        assert sermon_row(conn, sermon)["status"] == "failed"


@pytest.fixture()
def cleaned(conn, config, store, uploaded):
    """The same sermon after cleanup, with its transcription job waiting."""
    sermon, key, _ = uploaded
    make_runner(conn, config, store).run_once()
    return sermon, key


class TestTranscribeJob:
    def test_stores_the_words_the_uncertain_ones_and_moves_on_to_analysis(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        make_runner(conn, config, store, Scripted("Turn to Hebrews thirteen")).run_once()
        t = conn.execute("SELECT * FROM transcripts").fetchone()
        assert (t["version"], t["model"], t["language"]) == (1, "test:scripted", "en")
        assert t["full_text"] == "Turn to Hebrews thirteen"
        words = t["segments"][0]["words"]
        assert [w["w"] for w in words] == ["Turn", "to", "Hebrews", "thirteen"]
        assert words[1] == {"w": "to", "start": 0.5, "end": 0.9, "prob": 0.3}
        assert t["low_confidence"] == [[0, 1]]
        assert sermon_row(conn, sermon)["status"] == "analyzing"
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'running')"
            ).fetchone()["n"]
            == 0
        )

    def test_the_whole_pipeline_runs_from_upload_to_transcript(self, conn, config, store, uploaded):
        sermon, *_ = uploaded
        assert run_until_idle(make_runner(conn, config, store, Scripted())) == 2
        assert sermon_row(conn, sermon)["status"] == "analyzing"

    def test_transcribes_the_original_by_default(self, conn, config, store, cleaned):
        _, original_key = cleaned
        spy = SpyStore(store)
        make_runner(conn, config, spy).run_once()
        assert spy.downloads == [original_key]

    def test_can_be_told_to_use_the_cleaned_copy_instead(self, conn, config, store, cleaned):
        sermon, _ = cleaned
        spy = SpyStore(store)
        make_runner(conn, replace(config, transcribe_source="cleaned"), spy).run_once()
        assert spy.downloads[0].startswith(f"cleaned/{sermon}/")

    def test_primes_the_model_with_scripture_and_the_speaker(self, conn, config, store, cleaned):
        model = Scripted()
        make_runner(conn, config, store, model).run_once()
        assert "Hebrews" in model.calls[0]["prompt"] and model.calls[0]["prompt"].endswith(
            "A sermon by Pastor Lee."
        )

    def test_falls_back_to_the_churchs_default_speaker(self, conn, config, store, cleaned):
        sermon, _ = cleaned
        conn.execute("UPDATE sermons SET speaker = NULL WHERE id = %s", (sermon,))
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_speaker', '\"Pastor Kim\"'::jsonb)"
        )
        model = Scripted()
        make_runner(conn, config, store, model).run_once()
        assert model.calls[0]["prompt"].endswith("A sermon by Pastor Kim.")

    def test_a_second_transcription_is_a_new_version_not_an_overwrite(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        make_runner(conn, config, store, Scripted("first")).run_once()
        # the app's Retry: back into the stage, with a fresh job
        conn.execute("UPDATE sermons SET status = 'transcribing' WHERE id = %s", (sermon,))
        add_job(conn, sermon, "transcribe")
        make_runner(conn, config, store, Scripted("second")).run_once()
        rows = conn.execute(
            "SELECT version, full_text FROM transcripts ORDER BY version"
        ).fetchall()
        assert [(r["version"], r["full_text"]) for r in rows] == [(1, "first"), (2, "second")]

    def test_reports_progress_from_the_transcriber(self, conn, config, store, cleaned, monkeypatch):
        seen: list[int] = []
        real = queue.set_progress
        monkeypatch.setattr(queue, "set_progress", lambda c, j, p: (seen.append(p), real(c, j, p)))
        ticks = iter(range(0, 10_000, 5))
        make_runner(conn, config, store, Scripted(), clock=lambda: next(ticks)).run_once()
        assert seen == sorted(seen) and 0 < seen[0] < seen[-1] <= 100


class TestTranscribeFailures:
    def test_silence_fails_at_once_with_a_clear_message_and_no_retries(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        make_runner(conn, config, store, Scripted(text="")).run_once()
        s = sermon_row(conn, sermon)
        assert (s["status"], s["failed_stage"], s["last_error"]) == (
            "failed", "transcribing", "No speech was detected in this recording.",
        )  # fmt: skip
        assert (
            conn.execute("SELECT attempts FROM jobs WHERE type = 'transcribe'").fetchone()[
                "attempts"
            ]
            == 1
        )
        assert conn.execute("SELECT count(*) AS n FROM transcripts").fetchone()["n"] == 0

    def test_an_unexpected_error_is_retried_and_never_kills_the_worker(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        runner = make_runner(conn, config, store, Scripted(raises=RuntimeError("out of memory")))
        assert runner.run_once() is True  # returns normally
        job = conn.execute("SELECT * FROM jobs WHERE type = 'transcribe'").fetchone()
        assert job["state"] == "queued" and "RuntimeError: out of memory" in job["last_error"]
        assert sermon_row(conn, sermon)["status"] == "transcribing"

    def test_a_missing_model_is_explained_to_the_contributor(self, conn, config, store, cleaned):
        from sermon_worker.transcribe import ModelNotAvailable

        sermon, _ = cleaned
        conn.execute("UPDATE jobs SET max_attempts = 1 WHERE type = 'transcribe'")
        make_runner(conn, config, store, Scripted(raises=ModelNotAvailable("nope"))).run_once()
        assert (
            sermon_row(conn, sermon)["last_error"]
            == "The transcription model is not installed on the worker."
        )

    def test_if_the_sermon_is_deleted_mid_transcription_nothing_is_saved(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        deleter = Scripted(
            on_call=lambda: conn.execute(
                "UPDATE sermons SET deleted_at = now() WHERE id = %s", (sermon,)
            )
        )
        make_runner(conn, config, store, deleter).run_once()
        assert conn.execute("SELECT count(*) AS n FROM transcripts").fetchone()["n"] == 0
        assert (
            conn.execute("SELECT state FROM jobs WHERE type = 'transcribe'").fetchone()["state"]
            == "canceled"
        )


class TestFailedThenRetried:
    def test_a_failed_stage_recovers_when_the_app_queues_it_again(
        self, conn, config, store, cleaned
    ):
        sermon, _ = cleaned
        conn.execute("UPDATE jobs SET max_attempts = 1 WHERE type = 'transcribe'")
        make_runner(conn, config, store, Scripted(raises=RuntimeError("boom"))).run_once()
        assert sermon_row(conn, sermon)["status"] == "failed"
        # what the app's Retry does: back into the failed stage, error cleared, fresh job
        conn.execute(
            "UPDATE sermons SET status = 'transcribing', failed_stage = NULL, last_error = NULL WHERE id = %s",
            (sermon,),
        )
        add_job(conn, sermon, "transcribe")
        make_runner(conn, config, store, Scripted()).run_once()
        assert sermon_row(conn, sermon)["status"] == "analyzing"


class TestLoop:
    def test_processes_what_is_queued_then_idles_and_stops_on_request(
        self, conn, config, store, uploaded
    ):
        sleeps: list[float] = []
        stop_after_idle = {"idle": False}

        def sleep(seconds):
            sleeps.append(seconds)
            stop_after_idle["idle"] = True

        runner = make_runner(conn, config, store)
        runner.run_forever(lambda: stop_after_idle["idle"], sleep=sleep)
        assert sleeps == [config.poll_seconds]
        assert sermon_row(conn, uploaded[0])["status"] == "analyzing"

    def test_takes_back_abandoned_jobs_from_a_crashed_worker(self, conn, config, store):
        sermon = make_sermon(conn, "cleaning")
        add_job(conn, sermon, "clean", state="running", heartbeat_at="2020-01-01", attempts=1)
        stopped = {"n": 0}

        def should_stop():
            stopped["n"] += 1
            return stopped["n"] > 1

        make_runner(conn, config, store).run_forever(should_stop, sleep=lambda s: None)
        row = conn.execute("SELECT * FROM jobs").fetchone()
        assert "stopped responding" in (row["last_error"] or "")
