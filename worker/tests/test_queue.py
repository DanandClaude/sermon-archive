from __future__ import annotations

import threading
import time

import psycopg
import pytest
from conftest import add_job, job_row, make_sermon, sermon_row

from sermon_worker import queue
from sermon_worker.pipeline import InvalidTransition
from sermon_worker.queue import BACKOFF_SECONDS, Job


def seconds_until(conn, ts) -> float:
    return conn.execute("SELECT EXTRACT(EPOCH FROM (%s - now())) AS s", (ts,)).fetchone()["s"]


class TestClaim:
    def test_takes_the_oldest_due_job_and_marks_it_running(self, conn):
        first = add_job(conn, make_sermon(conn))
        add_job(conn, make_sermon(conn))
        job = queue.claim_job(conn, "w1")
        assert job.id == first and job.type == "clean" and job.attempts == 1
        row = job_row(conn, first)
        assert (row["state"], row["locked_by"], row["progress"]) == ("running", "w1", 0)
        assert row["heartbeat_at"] is not None and row["started_at"] is not None

    def test_returns_nothing_when_the_queue_is_empty(self, conn):
        assert queue.claim_job(conn, "w1") is None

    def test_skips_jobs_that_are_not_due_yet_and_jobs_already_taken(self, conn):
        later = add_job(conn, make_sermon(conn), run_after="2999-01-01")
        taken = add_job(conn, make_sermon(conn), state="running")
        assert queue.claim_job(conn, "w1") is None
        assert job_row(conn, later)["state"] == "queued"
        assert job_row(conn, taken)["state"] == "running"

    def test_ten_workers_racing_take_ten_jobs_exactly_once_each(self, conn, db_url):
        ids = {add_job(conn, make_sermon(conn)) for _ in range(10)}
        claimed: list[str] = []
        lock = threading.Lock()

        def work(name: str) -> None:
            c = queue.connect(db_url)
            try:
                while (job := queue.claim_job(c, name)) is not None:
                    with lock:
                        claimed.append(job.id)
                    time.sleep(0.01)
            finally:
                c.close()

        threads = [threading.Thread(target=work, args=(f"w{i}",)) for i in range(10)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert sorted(claimed) == sorted(ids)


class TestStartStage:
    def job(self, conn, sermon_id, job_type="clean") -> Job:
        add_job(conn, sermon_id, job_type)
        return queue.claim_job(conn, "w")

    def test_moves_an_uploaded_sermon_into_cleaning(self, conn):
        sermon = make_sermon(conn, "uploaded")
        assert queue.start_stage(conn, self.job(conn, sermon)) is True
        assert sermon_row(conn, sermon)["status"] == "cleaning"

    def test_a_retry_that_is_already_in_the_stage_is_fine(self, conn):
        sermon = make_sermon(conn, "cleaning")
        assert queue.start_stage(conn, self.job(conn, sermon)) is True

    def test_transcription_starts_from_cleaning_or_transcribing_only(self, conn):
        good = make_sermon(conn, "cleaning")
        assert queue.start_stage(conn, self.job(conn, good, "transcribe")) is True
        assert sermon_row(conn, good)["status"] == "transcribing"
        bad = make_sermon(conn, "uploaded")
        assert queue.start_stage(conn, self.job(conn, bad, "transcribe")) is False
        assert sermon_row(conn, bad)["status"] == "uploaded"

    @pytest.mark.parametrize("status", ["needs_review", "approved", "filed", "failed"])
    def test_refuses_a_sermon_that_has_moved_on(self, conn, status):
        sermon = make_sermon(conn, status)
        assert queue.start_stage(conn, self.job(conn, sermon)) is False
        assert sermon_row(conn, sermon)["status"] == status

    def test_refuses_a_deleted_sermon(self, conn):
        sermon = make_sermon(conn, "uploaded", deleted=True)
        assert queue.start_stage(conn, self.job(conn, sermon)) is False


class TestFailAttempt:
    def claimed(self, conn, status="cleaning", job_type="clean", attempts_before=0, max_attempts=3):
        sermon = make_sermon(conn, status)
        add_job(conn, sermon, job_type, attempts=attempts_before, max_attempts=max_attempts)
        return sermon, queue.claim_job(conn, "w")

    def test_requeues_with_a_growing_delay_while_attempts_remain(self, conn):
        for attempt, delay in [(0, 60), (1, 300)]:
            sermon, job = self.claimed(conn, attempts_before=attempt)
            assert queue.fail_attempt(conn, job, "boom", "friendly") == "retry"
            row = job_row(conn, job.id)
            assert row["state"] == "queued" and row["last_error"] == "boom"
            assert seconds_until(conn, row["run_after"]) == pytest.approx(delay, abs=3)
            assert sermon_row(conn, sermon)["status"] == "cleaning"  # not failed yet

    def test_backoff_table_is_one_two_three_steps(self):
        assert BACKOFF_SECONDS == (60, 300, 900)

    def test_fails_for_good_after_the_last_attempt_and_says_which_stage(self, conn):
        sermon, job = self.claimed(conn, "transcribing", "transcribe", attempts_before=2)
        assert job.attempts == 3
        assert queue.fail_attempt(conn, job, "detail", "Something went wrong.") == "failed"
        assert job_row(conn, job.id)["state"] == "failed"
        s = sermon_row(conn, sermon)
        assert (s["status"], s["failed_stage"], s["last_error"]) == (
            "failed", "transcribing", "Something went wrong.",
        )  # fmt: skip

    def test_a_permanent_error_fails_at_once_without_retrying(self, conn):
        sermon, job = self.claimed(conn, "cleaning")
        assert queue.fail_attempt(conn, job, "d", "No speech.", permanent=True) == "failed"
        assert sermon_row(conn, sermon)["failed_stage"] == "cleaning"

    def test_a_sermon_that_moved_on_is_left_alone(self, conn):
        sermon, job = self.claimed(conn, "cleaning", max_attempts=1)
        conn.execute("UPDATE sermons SET status = 'needs_review' WHERE id = %s", (sermon,))
        queue.fail_attempt(conn, job, "d", "f")
        assert sermon_row(conn, sermon)["status"] == "needs_review"
        assert job_row(conn, job.id)["state"] == "failed"

    def test_long_messages_are_trimmed(self, conn):
        sermon, job = self.claimed(conn, max_attempts=1)
        queue.fail_attempt(conn, job, "x" * 5000, "y" * 5000)
        assert len(job_row(conn, job.id)["last_error"]) == 1000
        assert len(sermon_row(conn, sermon)["last_error"]) == 300


class TestReap:
    def test_takes_back_a_job_whose_worker_stopped_beating(self, conn):
        sermon = make_sermon(conn, "cleaning")
        add_job(conn, sermon, state="running", heartbeat_at="2020-01-01", attempts=1)
        assert queue.reap_stale(conn, 600) == 1
        row = conn.execute("SELECT * FROM jobs").fetchone()
        assert row["state"] == "queued" and "stopped responding" in row["last_error"]

    def test_leaves_a_job_with_a_fresh_heartbeat(self, conn):
        add_job(conn, make_sermon(conn, "cleaning"), state="running", heartbeat_at="2999-01-01")
        assert queue.reap_stale(conn, 600) == 0

    def test_fails_the_sermon_if_that_was_the_last_attempt(self, conn):
        sermon = make_sermon(conn, "cleaning")
        add_job(conn, sermon, state="running", heartbeat_at="2020-01-01", attempts=3)
        queue.reap_stale(conn, 600)
        assert sermon_row(conn, sermon)["status"] == "failed"


class TestEnqueueAndAdvance:
    def test_enqueue_is_idempotent_while_a_job_is_active(self, conn):
        sermon = make_sermon(conn)
        assert queue.enqueue(conn, sermon, "transcribe") is True
        assert queue.enqueue(conn, sermon, "transcribe") is False
        assert queue.enqueue(conn, sermon, "clean") is True

    def test_advance_moves_a_sermon_only_if_it_is_still_where_we_thought(self, conn):
        sermon = make_sermon(conn, "cleaning")
        queue.advance_sermon(conn, sermon, "cleaning", "transcribing")
        assert sermon_row(conn, sermon)["status"] == "transcribing"
        with pytest.raises(queue.StageMoved):
            queue.advance_sermon(conn, sermon, "cleaning", "transcribing")

    def test_advance_refuses_a_move_the_state_machine_forbids(self, conn):
        sermon = make_sermon(conn, "uploaded")
        with pytest.raises(InvalidTransition):
            queue.advance_sermon(conn, sermon, "uploaded", "approved")
        assert sermon_row(conn, sermon)["status"] == "uploaded"


class TestHeartbeat:
    def test_records_the_worker_and_updates_it_on_each_beat(self, conn):
        queue.write_heartbeat(conn, "mac", {"host": "mac"}, None)
        queue.write_heartbeat(conn, "mac", {"host": "mac", "job": "j"}, None)
        rows = conn.execute("SELECT * FROM worker_heartbeats").fetchall()
        assert len(rows) == 1 and rows[0]["info"]["job"] == "j"

    def test_a_beat_also_refreshes_the_running_job(self, conn):
        job_id = add_job(
            conn, make_sermon(conn, "cleaning"), state="running", heartbeat_at="2020-01-01"
        )
        queue.write_heartbeat(conn, "mac", {}, job_id)
        assert job_row(conn, job_id)["heartbeat_at"].year >= 2026

    def test_the_background_thread_beats_while_the_main_thread_is_busy(self, conn, db_url):
        beat = queue.Heartbeat(db_url, "bg", 0.05, {"host": "bg"})
        beat.start()
        time.sleep(0.4)
        beat.stop()
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM worker_heartbeats WHERE worker_id = 'bg'"
            ).fetchone()["n"]
            == 1
        )
        assert not beat._thread.is_alive()

    def test_keeps_trying_after_the_database_is_unreachable(self, conn):
        beat = queue.Heartbeat("postgres://localhost:1/nope", "bg", 0.05, {})
        beat.start()
        time.sleep(0.2)
        beat.stop()  # must not raise or hang


def test_a_bad_connection_string_fails_clearly():
    with pytest.raises(psycopg.OperationalError):
        queue.connect("postgres://localhost:1/nope")
