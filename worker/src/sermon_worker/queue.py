"""The job queue in Postgres. Every function takes a connection in autocommit mode."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from . import pipeline

# Wait this long after the 1st, 2nd, 3rd... failed attempt before trying again.
BACKOFF_SECONDS = (60, 300, 900)


@dataclass(frozen=True)
class Job:
    id: str
    sermon_id: str
    type: str
    attempts: int
    max_attempts: int
    payload: dict | None = None


class PermanentError(Exception):
    """Trying again cannot help (for example, the recording contains no speech)."""


class StageMoved(Exception):
    """The sermon was deleted or moved on while the job ran, so its result is discarded."""


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, autocommit=True, row_factory=dict_row)


def _job(row: dict) -> Job:
    return Job(
        str(row["id"]), str(row["sermon_id"]), row["type"], row["attempts"], row["max_attempts"],
        row.get("payload"),
    )  # fmt: skip


def claim_job(conn: psycopg.Connection, worker_id: str) -> Job | None:
    """Takes the oldest due job. SKIP LOCKED means two workers never take the same one."""
    row = conn.execute(
        """
        UPDATE jobs SET state = 'running', locked_by = %(worker)s, started_at = now(),
               heartbeat_at = now(), attempts = attempts + 1, progress = 0
        WHERE id = (
          SELECT id FROM jobs WHERE state = 'queued' AND run_after <= now()
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id, sermon_id, type, attempts, max_attempts, payload
        """,
        {"worker": worker_id},
    ).fetchone()
    return _job(row) if row else None


def set_progress(conn: psycopg.Connection, job_id: str, percent: int) -> None:
    conn.execute(
        "UPDATE jobs SET progress = %s, heartbeat_at = now() WHERE id = %s AND state = 'running'",
        (max(0, min(100, percent)), job_id),
    )


def start_stage(conn: psycopg.Connection, job: Job) -> bool:
    """Moves the sermon into the stage this job performs. False if it can no longer be done
    (the sermon was deleted or is not waiting for this step)."""
    cfg = pipeline.job_config(job.type)
    running = cfg["runningStatus"]
    for origin in cfg["startFrom"]:
        if origin != running:
            pipeline.assert_transition(origin, running)
    row = conn.execute(
        """
        UPDATE sermons SET status = %s::sermon_status, updated_at = now()
        WHERE id = %s AND deleted_at IS NULL AND status = ANY(%s::sermon_status[]) RETURNING id
        """,
        (running, job.sermon_id, cfg["startFrom"]),
    ).fetchone()
    return row is not None


def cancel_job(conn: psycopg.Connection, job: Job, reason: str) -> None:
    conn.execute(
        "UPDATE jobs SET state = 'canceled', last_error = %s, finished_at = now(), locked_by = NULL "
        "WHERE id = %s",
        (reason, job.id),
    )


def enqueue(conn: psycopg.Connection, sermon_id: str, job_type: str) -> bool:
    row = conn.execute(
        "INSERT INTO jobs (sermon_id, type) VALUES (%s, %s::job_type) ON CONFLICT DO NOTHING RETURNING id",
        (sermon_id, job_type),
    ).fetchone()
    return row is not None


def reconcile_analysis(conn: psycopg.Connection) -> int:
    """Queues analysis for any sermon waiting at "analyzing" that has no analysis job, such as
    transcripts finished before analysis existed. Safe to run at any time."""
    rows = conn.execute(
        """
        INSERT INTO jobs (sermon_id, type)
        SELECT s.id, 'analyze' FROM sermons s
        WHERE s.status = 'analyzing' AND s.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM transcripts t WHERE t.sermon_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.sermon_id = s.id AND j.type = 'analyze'
                          AND j.state IN ('queued', 'running'))
        ON CONFLICT DO NOTHING RETURNING id
        """
    ).fetchall()
    return len(rows)


def advance_sermon(conn: psycopg.Connection, sermon_id: str, old: str, new: str) -> None:
    """Compare-and-set status change. Raises StageMoved if the sermon is no longer in `old`."""
    pipeline.assert_transition(old, new)
    row = conn.execute(
        "UPDATE sermons SET status = %s::sermon_status, updated_at = now() "
        "WHERE id = %s AND deleted_at IS NULL AND status = %s::sermon_status RETURNING id",
        (new, sermon_id, old),
    ).fetchone()
    if row is None:
        raise StageMoved(f"Sermon {sermon_id} is no longer {old}.")


def mark_succeeded(conn: psycopg.Connection, job_id: str) -> None:
    conn.execute(
        "UPDATE jobs SET state = 'succeeded', progress = 100, finished_at = now(), locked_by = NULL, "
        "last_error = NULL WHERE id = %s",
        (job_id,),
    )


def fail_attempt(
    conn: psycopg.Connection,
    job: Job,
    detail: str,
    friendly: str,
    permanent: bool = False,
) -> str:
    """Records a failed attempt. Requeues with backoff, or fails for good after the last attempt.
    Returns 'retry' or 'failed'."""
    if not permanent and job.attempts < job.max_attempts:
        delay = BACKOFF_SECONDS[min(job.attempts, len(BACKOFF_SECONDS)) - 1]
        conn.execute(
            "UPDATE jobs SET state = 'queued', locked_by = NULL, progress = 0, last_error = %s, "
            "run_after = now() + make_interval(secs => %s) WHERE id = %s",
            (detail[:1000], delay, job.id),
        )
        return "retry"

    running = pipeline.job_config(job.type)["runningStatus"]
    pipeline.assert_transition(running, "failed")
    with conn.transaction():
        conn.execute(
            "UPDATE jobs SET state = 'failed', locked_by = NULL, finished_at = now(), last_error = %s "
            "WHERE id = %s",
            (detail[:1000], job.id),
        )
        conn.execute(
            "UPDATE sermons SET status = 'failed', failed_stage = %s, last_error = %s, updated_at = now() "
            "WHERE id = %s AND status = %s::sermon_status",
            (running, friendly[:300], job.sermon_id, running),
        )
    return "failed"


def reap_stale(conn: psycopg.Connection, stale_seconds: int) -> int:
    """Takes back jobs whose worker vanished (crash, power off). They count as a failed attempt."""
    rows = conn.execute(
        """
        SELECT id, sermon_id, type, attempts, max_attempts, payload FROM jobs
        WHERE state = 'running' AND heartbeat_at < now() - make_interval(secs => %s)
        """,
        (stale_seconds,),
    ).fetchall()
    for row in rows:
        fail_attempt(
            conn, _job(row), "The worker stopped responding while running this job.",
            "Processing was interrupted. Try again.",
        )  # fmt: skip
    return len(rows)


def write_heartbeat(
    conn: psycopg.Connection, worker_id: str, info: dict, job_id: str | None
) -> None:
    conn.execute(
        "INSERT INTO worker_heartbeats (worker_id, last_seen_at, info) VALUES (%s, now(), %s::jsonb) "
        "ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), info = EXCLUDED.info",
        (worker_id, json.dumps(info)),
    )
    if job_id:
        conn.execute(
            "UPDATE jobs SET heartbeat_at = now() WHERE id = %s AND state = 'running'", (job_id,)
        )


class Heartbeat:
    """Checks in every few seconds from its own connection, even while a long job is running,
    so the app can tell a busy worker from a stopped one."""

    def __init__(self, url: str, worker_id: str, interval: float, info: dict):
        self.url, self.worker_id, self.interval, self.info = url, worker_id, interval, info
        self.current_job: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="heartbeat")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        conn = None
        while not self._stop.is_set():
            try:
                if conn is None or conn.closed:
                    conn = connect(self.url)
                write_heartbeat(
                    conn, self.worker_id, {**self.info, "job": self.current_job}, self.current_job
                )
            except Exception as error:  # keep trying; a missed beat only makes the app cautious
                print(f"heartbeat failed: {error}", flush=True)
                conn = None
            self._stop.wait(self.interval)
        if conn is not None and not conn.closed:
            conn.close()
