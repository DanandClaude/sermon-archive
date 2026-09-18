"""Runs jobs: cleanup, then transcription. Each stage writes new assets and never edits old ones."""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from . import pipeline, queue
from .clean import CleanConfig, clean_audio
from .config import Config
from .media import MediaError, compute_peaks
from .queue import Job, PermanentError, StageMoved
from .store import ObjectNotFound, ObjectStore
from .transcribe import Transcriber, build_prompt

PROGRESS_INTERVAL = 1.0


class NoSpeech(PermanentError):
    pass


def friendly(error: Exception) -> str:
    """What the contributor sees. The full detail goes to the job record for admins."""
    from .transcribe import ModelNotAvailable

    if isinstance(error, NoSpeech):
        return "No speech was detected in this recording."
    if isinstance(error, ObjectNotFound):
        return "The audio file could not be found in storage."
    if isinstance(error, MediaError):
        return "The audio file could not be processed. It may be damaged."
    if isinstance(error, ModelNotAvailable):
        return "The transcription model is not installed on the worker."
    if isinstance(error, PermanentError):
        return str(error)[:200]
    return "Something went wrong while processing this recording."


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


class Runner:
    def __init__(
        self,
        conn: psycopg.Connection,
        config: Config,
        store: ObjectStore,
        transcriber: Transcriber,
        clean_config: CleanConfig | None = None,
        heartbeat=None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.conn, self.config, self.store, self.transcriber = conn, config, store, transcriber
        self.clean_config = clean_config or CleanConfig()
        self.heartbeat = heartbeat
        self.clock = clock

    # -- one job -----------------------------------------------------------------------------

    def run_once(self) -> bool:
        """Claims and runs one due job. Returns False when there was nothing to do."""
        job = queue.claim_job(self.conn, self.config.worker_id)
        if job is None:
            return False
        if self.heartbeat:
            self.heartbeat.current_job = job.id
        try:
            self._process(job)
        finally:
            if self.heartbeat:
                self.heartbeat.current_job = None
        return True

    def _process(self, job: Job) -> None:
        try:
            if not queue.start_stage(self.conn, job):
                queue.cancel_job(self.conn, job, "The sermon is no longer waiting for this step.")
                return
            {"clean": self._clean, "transcribe": self._transcribe}[job.type](job)
        except StageMoved as moved:
            queue.cancel_job(self.conn, job, str(moved))
        except Exception as error:  # every failure is recorded; none may kill the worker
            detail = f"{type(error).__name__}: {error}"
            outcome = queue.fail_attempt(
                self.conn, job, detail, friendly(error), permanent=isinstance(error, PermanentError)
            )
            print(
                f"job {job.id} ({job.type}) attempt {job.attempts}: {detail} -> {outcome}",
                flush=True,
            )

    def _reporter(self, job: Job, low: float, high: float) -> Callable[[float], None]:
        """Turns a stage's 0-1 progress into a slice of the job's 0-100, at most once a second."""
        last = [-PROGRESS_INTERVAL]

        def report(fraction: float) -> None:
            now = self.clock()
            if fraction < 1 and now - last[0] < PROGRESS_INTERVAL:
                return
            last[0] = now
            queue.set_progress(self.conn, job.id, round((low + (high - low) * fraction) * 100))

        return report

    # -- cleanup ------------------------------------------------------------------------------

    def _clean(self, job: Job) -> None:
        original = self.conn.execute(
            "SELECT id, storage_key, peaks_key FROM audio_assets WHERE sermon_id = %s AND kind = 'original'",
            (job.sermon_id,),
        ).fetchone()
        if original is None:
            raise PermanentError("This sermon has no uploaded audio.")

        with tempfile.TemporaryDirectory(prefix="sermon-clean-") as tmp:
            src = Path(tmp) / f"original{Path(original['storage_key']).suffix}"
            cleaned = Path(tmp) / "cleaned.mp3"
            self.store.download(original["storage_key"], src)
            result = clean_audio(src, cleaned, self.clean_config, self._reporter(job, 0.02, 0.88))
            original_peaks = None if original["peaks_key"] else compute_peaks(src)
            cleaned_peaks = compute_peaks(cleaned)

            cleaned_key = f"cleaned/{job.sermon_id}/{job.id}.mp3"
            cleaned_peaks_key = f"peaks/{job.sermon_id}/{job.id}-cleaned.json"
            self.store.upload(cleaned_key, cleaned, "audio/mpeg")
            self.store.upload_bytes(
                cleaned_peaks_key, json.dumps(cleaned_peaks).encode(), "application/json"
            )
            original_peaks_key = original["peaks_key"]
            if original_peaks is not None:
                original_peaks_key = f"peaks/{job.sermon_id}/original.json"
                self.store.upload_bytes(
                    original_peaks_key, json.dumps(original_peaks).encode(), "application/json"
                )
            sha, size = _sha256(cleaned), cleaned.stat().st_size

        duration = round(result["duration"])
        cfg = pipeline.job_config("clean")
        with self.conn.transaction():
            self.conn.execute(
                """
                INSERT INTO audio_assets (sermon_id, kind, storage_key, sha256, bytes, mime,
                                          original_filename, duration_sec, peaks_key)
                VALUES (%s, 'cleaned', %s, %s, %s, 'audio/mpeg', 'cleaned.mp3', %s, %s)
                ON CONFLICT (storage_key) DO NOTHING
                """,
                (job.sermon_id, cleaned_key, sha, size, duration, cleaned_peaks_key),
            )
            self.conn.execute(
                "UPDATE audio_assets SET peaks_key = COALESCE(peaks_key, %s), duration_sec = COALESCE(duration_sec, %s) "
                "WHERE id = %s",
                (original_peaks_key, round(result["source_duration"]), original["id"]),
            )
            self.conn.execute(
                "UPDATE sermons SET duration_sec = %s WHERE id = %s",
                (round(result["source_duration"]), job.sermon_id),
            )
            queue.mark_succeeded(self.conn, job.id)
            queue.advance_sermon(
                self.conn, job.sermon_id, cfg["runningStatus"], cfg["onSuccess"]["status"]
            )
            if cfg["onSuccess"]["enqueue"]:
                queue.enqueue(self.conn, job.sermon_id, cfg["onSuccess"]["enqueue"])

    # -- transcription ------------------------------------------------------------------------

    def _speaker(self, sermon_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT speaker FROM sermons WHERE id = %s", (sermon_id,)
        ).fetchone()
        if row and row["speaker"]:
            return row["speaker"]
        default = self.conn.execute(
            "SELECT value FROM settings WHERE key = 'default_speaker'"
        ).fetchone()
        value = default["value"] if default else None
        return value if isinstance(value, str) and value.strip() else None

    def _audio_asset(self, sermon_id: str) -> dict:
        wanted = (
            ("cleaned", "original") if self.config.transcribe_source == "cleaned" else ("original",)
        )
        for kind in wanted:
            row = self.conn.execute(
                "SELECT storage_key FROM audio_assets WHERE sermon_id = %s AND kind = %s::audio_kind "
                "ORDER BY created_at DESC LIMIT 1",
                (sermon_id, kind),
            ).fetchone()
            if row:
                return row
        raise PermanentError("This sermon has no audio to transcribe.")

    def _transcribe(self, job: Job) -> None:
        asset = self._audio_asset(job.sermon_id)
        prompt = build_prompt(self._speaker(job.sermon_id))
        with tempfile.TemporaryDirectory(prefix="sermon-transcribe-") as tmp:
            src = Path(tmp) / f"audio{Path(asset['storage_key']).suffix}"
            self.store.download(asset["storage_key"], src)
            result = self.transcriber.transcribe(
                src, prompt=prompt, on_progress=self._reporter(job, 0.02, 0.98)
            )

        if not result.full_text:
            raise NoSpeech("The transcriber found no speech.")
        cfg = pipeline.job_config("transcribe")
        with self.conn.transaction():
            # Serialise per sermon so two runs can't both pick the same version number.
            self.conn.execute("SELECT id FROM sermons WHERE id = %s FOR UPDATE", (job.sermon_id,))
            version = self.conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM transcripts WHERE sermon_id = %s",
                (job.sermon_id,),
            ).fetchone()["v"]
            self.conn.execute(
                """
                INSERT INTO transcripts (sermon_id, version, model, language, full_text, segments, low_confidence)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job.sermon_id, version, result.model, result.language, result.full_text,
                    Jsonb(result.segments_json()),
                    Jsonb(result.low_confidence(self.config.low_confidence_threshold)),
                ),
            )  # fmt: skip
            queue.mark_succeeded(self.conn, job.id)
            queue.advance_sermon(
                self.conn, job.sermon_id, cfg["runningStatus"], cfg["onSuccess"]["status"]
            )
            if cfg["onSuccess"]["enqueue"]:
                queue.enqueue(self.conn, job.sermon_id, cfg["onSuccess"]["enqueue"])

    # -- loop ---------------------------------------------------------------------------------

    def run_forever(
        self, should_stop: Callable[[], bool], sleep: Callable[[float], None] = time.sleep
    ) -> None:
        last_reap = 0.0
        while not should_stop():
            if self.clock() - last_reap > 60:
                reaped = queue.reap_stale(self.conn, self.config.stale_job_seconds)
                if reaped:
                    print(f"took back {reaped} abandoned job(s)", flush=True)
                last_reap = self.clock()
            if not self.run_once():
                sleep(self.config.poll_seconds)
