"""The analysis stage: what it writes, what it must never overwrite, and how it fails."""

from __future__ import annotations

import json

import pytest
from conftest import add_job, job_row, make_sermon, sermon_row
from test_analysis import Scripted, segments_from
from test_runner import Scripted as ScriptedTranscriber

from sermon_worker import queue
from sermon_worker.analysis import Addition, AnalysisError, FakeAnalyzer
from sermon_worker.queue import PermanentError
from sermon_worker.runner import Runner
from sermon_worker.scripture import Reference

SAID = (
    "Good morning. Turn with me to Hebrews thirteen verse seventeen. @900 "
    "First Peter chapter five verses two and three tells elders the same."
)


def make_runner(conn, config, store, analyzer=None) -> Runner:
    return Runner(conn, config, store, ScriptedTranscriber(), analyzer=analyzer or FakeAnalyzer())


def add_transcript(conn, sermon, text=SAID, version=1):
    segments = segments_from(text)
    conn.execute(
        "INSERT INTO transcripts (sermon_id, version, model, language, full_text, segments, low_confidence) "
        "VALUES (%s, %s, 'test', 'en', %s, %s, '[]')",
        (sermon, version, text, json.dumps(segments)),
    )


@pytest.fixture()
def waiting(conn):
    """A sermon that has been transcribed and is waiting for analysis."""
    sermon = make_sermon(conn, "analyzing", speaker="Pastor Lee")
    conn.execute("UPDATE sermons SET duration_sec = 2700 WHERE id = %s", (sermon,))
    add_transcript(conn, sermon)
    job = add_job(conn, sermon, "analyze")
    return sermon, job


def refs(conn, sermon):
    return conn.execute(
        "SELECT * FROM scripture_refs WHERE sermon_id = %s ORDER BY spoken_at_sec", (sermon,)
    ).fetchall()


def tag_names(conn, sermon):
    rows = conn.execute(
        "SELECT t.kind, t.name FROM sermon_tags st JOIN tags t ON t.id = st.tag_id "
        "WHERE st.sermon_id = %s",
        (sermon,),
    ).fetchall()
    return sorted(f"{r['kind']}:{r['name']}" for r in rows)


class TestAnalyzeJob:
    def test_writes_the_title_summary_passages_and_tags_and_moves_to_review(
        self, conn, config, store, waiting
    ):
        sermon, job = waiting
        assert make_runner(conn, config, store).run_once()
        s = sermon_row(conn, sermon)
        assert s["status"] == "needs_review"
        assert s["title"] == "Sermon on Hebrews 13"
        assert "fake analyzer" in s["summary_text"] and s["summary_source"] == "auto"
        assert s["primary_passage"] == {
            "book": "Hebrews", "chapter": 13, "verseStart": 17, "verseEnd": None,
        }  # fmt: skip
        assert job_row(conn, job)["state"] == "succeeded"
        assert tag_names(conn, sermon) == [
            "book:Hebrews", "genre:Epistle", "testament:New Testament",
        ]  # fmt: skip

    def test_stores_each_named_passage_with_its_time_and_what_the_system_found(
        self, conn, config, store, waiting
    ):
        sermon, _ = waiting
        make_runner(conn, config, store).run_once()
        rows = refs(conn, sermon)
        assert [(r["book"], r["chapter"], r["verse_start"], r["verse_end"]) for r in rows] == [
            ("Hebrews", 13, 17, None), ("1 Peter", 5, 2, 3),
        ]  # fmt: skip
        assert [r["spoken_at_sec"] for r in rows] == [3.0, 900.0]
        assert [r["is_main_text"] for r in rows] == [True, False]
        assert all(r["source"] == "auto" and r["deleted_at"] is None for r in rows)
        assert rows[1]["detected_original"] == {
            "book": "1 Peter", "chapter": 5, "verseStart": 2, "verseEnd": 3,
        }  # fmt: skip
        assert rows[1]["context_note"]

    def test_keeps_the_raw_answer_and_which_transcript_it_was_about(
        self, conn, config, store, waiting
    ):
        sermon, _ = waiting
        make_runner(conn, config, store).run_once()
        a = conn.execute("SELECT * FROM analyses WHERE sermon_id = %s", (sermon,)).fetchone()
        assert (a["analyzer"], a["model"], a["prompt_version"], a["transcript_version"]) == (
            "fake", "fake", "fake-1", 1,
        )  # fmt: skip
        assert a["raw_output"]["output"]["fake"] is True

    def test_uses_the_tape_label_as_the_main_passage(self, conn, config, store, waiting):
        sermon, _ = waiting
        conn.execute(
            "UPDATE sermons SET label_scripture = 'Romans 8:28-39' WHERE id = %s", (sermon,)
        )
        make_runner(conn, config, store).run_once()
        assert sermon_row(conn, sermon)["primary_passage"]["book"] == "Romans"
        assert tag_names(conn, sermon) == [
            "book:Romans",
            "genre:Epistle",
            "testament:New Testament",
        ]
        assert not any(r["is_main_text"] for r in refs(conn, sermon))

    def test_never_overwrites_a_title_an_edited_summary_or_a_chosen_passage(
        self, conn, config, store, waiting
    ):
        sermon, _ = waiting
        conn.execute(
            "UPDATE sermons SET title = 'Typed at upload', summary_text = 'My words', "
            "summary_source = 'edited', primary_passage = %s WHERE id = %s",
            (
                json.dumps({"book": "John", "chapter": 3, "verseStart": 16, "verseEnd": None}),
                sermon,
            ),
        )
        make_runner(conn, config, store).run_once()
        s = sermon_row(conn, sermon)
        assert (s["title"], s["summary_text"], s["summary_source"]) == (
            "Typed at upload", "My words", "edited",
        )  # fmt: skip
        assert s["primary_passage"]["book"] == "John"
        assert tag_names(conn, sermon) == []  # tags follow the main passage, which is unchanged

    def test_topics_are_reused_whatever_their_capitals(self, conn, config, store, waiting):
        sermon, _ = waiting
        conn.execute("INSERT INTO tags (kind, name) VALUES ('topic', 'Trust')")
        analyzer = Scripted(title="T", summary="S", topics=["trust", "Prayer"])
        make_runner(conn, config, store, analyzer).run_once()
        assert tag_names(conn, sermon) == [
            "book:Hebrews", "genre:Epistle", "testament:New Testament", "topic:Prayer", "topic:Trust",
        ]  # fmt: skip
        assert (
            conn.execute("SELECT count(*) AS n FROM tags WHERE kind = 'topic'").fetchone()["n"] == 2
        )
        assert analyzer.seen.known_topics == ["Trust"]

    def test_a_passage_the_model_adds_is_stored_as_auto_with_its_quoted_time(
        self, conn, config, store
    ):
        sermon = make_sermon(conn, "analyzing")
        add_transcript(
            conn, sermon, "Now @1000 open your bibles to the book of Habakuk chapter two."
        )
        add_job(conn, sermon, "analyze")
        analyzer = Scripted(
            additions=[
                Addition(Reference("Habakkuk", 2), "the book of Habakuk chapter two", "watch")
            ]
        )
        make_runner(conn, config, store, analyzer).run_once()
        [row] = refs(conn, sermon)
        assert (row["book"], row["source"], row["spoken_at_sec"], row["context_note"]) == (
            "Habakkuk", "auto", 1002.0, "watch",
        )  # fmt: skip


class TestReanalysis:
    def test_replaces_what_it_found_before_but_keeps_what_a_person_did(
        self, conn, config, store, waiting
    ):
        sermon, _ = waiting
        conn.execute(
            "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, spoken_at_sec, source) "
            "VALUES (%s, 'John', 3, 16, 50, 'auto')",  # found earlier, untouched: replaced
            (sermon,),
        )
        conn.execute(
            "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, spoken_at_sec, source) "
            "VALUES (%s, 'Jude', 1, 3, 60, 'manual')",  # added by a person: kept
            (sermon,),
        )
        conn.execute(
            "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, spoken_at_sec, source, "
            "edited_at) VALUES (%s, 'Acts', 9, 26, 70, 'auto', now())",  # corrected: kept
            (sermon,),
        )
        make_runner(conn, config, store).run_once()
        assert [r["book"] for r in refs(conn, sermon)] == ["Hebrews", "Jude", "Acts", "1 Peter"]

    def test_does_not_bring_back_a_passage_the_reviewer_deleted(self, conn, config, store, waiting):
        sermon, _ = waiting
        conn.execute(
            "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, spoken_at_sec, source, "
            "deleted_at) VALUES (%s, 'Hebrews', 13, 17, 3, 'auto', now())",
            (sermon,),
        )
        make_runner(conn, config, store).run_once()
        live = [r for r in refs(conn, sermon) if r["deleted_at"] is None]
        assert [r["book"] for r in live] == ["1 Peter"]

    def test_a_new_summary_changes_only_the_summary(self, conn, config, store):
        sermon = make_sermon(conn, "analyzing")
        add_transcript(conn, sermon)
        conn.execute(
            "UPDATE sermons SET title = 'Kept', summary_text = 'Old', summary_source = 'edited', "
            "primary_passage = %s WHERE id = %s",
            (
                json.dumps({"book": "John", "chapter": 3, "verseStart": None, "verseEnd": None}),
                sermon,
            ),
        )
        conn.execute(
            "INSERT INTO scripture_refs (sermon_id, book, chapter, spoken_at_sec, source) "
            "VALUES (%s, 'Jude', 1, 60, 'manual')",
            (sermon,),
        )
        job = add_job(conn, sermon, "analyze", payload=json.dumps({"only": "summary"}))
        make_runner(conn, config, store, Scripted(summary="A fresh summary.")).run_once()
        s = sermon_row(conn, sermon)
        assert s["status"] == "needs_review"
        assert (s["title"], s["summary_text"], s["summary_source"]) == (
            "Kept", "A fresh summary.", "auto",
        )  # fmt: skip
        assert [r["book"] for r in refs(conn, sermon)] == ["Jude"]
        assert job_row(conn, job)["state"] == "succeeded"


class TestAnalyzeFailures:
    def test_a_sermon_with_no_transcript_fails_at_once(self, conn, config, store):
        sermon = make_sermon(conn, "analyzing")
        job = add_job(conn, sermon, "analyze")
        make_runner(conn, config, store).run_once()
        assert sermon_row(conn, sermon)["status"] == "failed"
        assert sermon_row(conn, sermon)["failed_stage"] == "analyzing"
        assert "no transcript" in sermon_row(conn, sermon)["last_error"]
        assert job_row(conn, job)["attempts"] == 1

    def test_a_temporary_problem_is_retried_and_leaves_the_sermon_waiting(
        self, conn, config, store, waiting
    ):
        sermon, job = waiting

        class Flaky:
            name, model, prompt_version = "flaky", "f", "1"

            def analyze(self, data):
                raise AnalysisError("The summary service’s answer could not be read.")

        make_runner(conn, config, store, Flaky()).run_once()
        assert job_row(conn, job)["state"] == "queued"
        assert sermon_row(conn, sermon)["status"] == "analyzing"
        assert conn.execute("SELECT count(*) AS n FROM scripture_refs").fetchone()["n"] == 0

    def test_a_setup_problem_fails_the_sermon_with_a_plain_message(
        self, conn, config, store, waiting
    ):
        sermon, job = waiting

        class Broken:
            name, model, prompt_version = "broken", "b", "1"

            def analyze(self, data):
                raise PermanentError("The summary service refused the request. Check the key.")

        make_runner(conn, config, store, Broken()).run_once()
        assert job_row(conn, job)["state"] == "failed"
        s = sermon_row(conn, sermon)
        assert s["status"] == "failed" and "Check the key" in s["last_error"]

    def test_a_failed_analysis_can_be_queued_again_by_the_app(self, conn, config, store, waiting):
        sermon, job = waiting
        conn.execute("UPDATE jobs SET state = 'failed' WHERE id = %s", (job,))
        conn.execute(
            "UPDATE sermons SET status = 'failed', failed_stage = 'analyzing' WHERE id = %s",
            (sermon,),
        )
        # the app's Retry: back into the stage, with a fresh job
        conn.execute(
            "UPDATE sermons SET status = 'analyzing', failed_stage = NULL WHERE id = %s", (sermon,)
        )
        add_job(conn, sermon, "analyze")
        make_runner(conn, config, store).run_once()
        assert sermon_row(conn, sermon)["status"] == "needs_review"

    def test_if_the_sermon_is_deleted_while_analyzing_nothing_is_saved(
        self, conn, config, store, waiting
    ):
        sermon, job = waiting

        class DeletesIt(FakeAnalyzer):
            def analyze(self, data):
                conn.execute("UPDATE sermons SET deleted_at = now() WHERE id = %s", (sermon,))
                return super().analyze(data)

        make_runner(conn, config, store, DeletesIt()).run_once()
        assert job_row(conn, job)["state"] == "canceled"
        assert conn.execute("SELECT count(*) AS n FROM scripture_refs").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM analyses").fetchone()["n"] == 0


class TestReconcile:
    def test_queues_analysis_for_a_transcribed_sermon_that_has_no_job(self, conn):
        sermon = make_sermon(conn, "analyzing")
        add_transcript(conn, sermon)
        assert queue.reconcile_analysis(conn) == 1
        assert queue.reconcile_analysis(conn) == 0  # nothing more to do the second time
        assert conn.execute("SELECT type, state FROM jobs").fetchall() == [
            {"type": "analyze", "state": "queued"}
        ]

    def test_leaves_alone_sermons_that_are_elsewhere_deleted_or_without_a_transcript(self, conn):
        other = make_sermon(conn, "needs_review")
        add_transcript(conn, other)
        gone = make_sermon(conn, "analyzing", deleted=True)
        add_transcript(conn, gone)
        make_sermon(conn, "analyzing")  # no transcript yet
        assert queue.reconcile_analysis(conn) == 0

    def test_does_not_double_up_when_a_job_is_already_waiting(self, conn):
        sermon = make_sermon(conn, "analyzing")
        add_transcript(conn, sermon)
        add_job(conn, sermon, "analyze")
        assert queue.reconcile_analysis(conn) == 0


def test_a_cut_off_answer_is_explained_kindly_to_the_contributor(conn, config, store, waiting):
    sermon, job = waiting

    class CutOff:
        name, model, prompt_version = "cut", "c", "1"

        def analyze(self, data):
            raise AnalysisError("The summary service’s answer was cut off after 6000 tokens.")

    conn.execute("UPDATE jobs SET attempts = 2 WHERE id = %s", (job,))
    make_runner(conn, config, store, CutOff()).run_once()
    s = sermon_row(conn, sermon)
    assert s["status"] == "failed" and "Try again" in s["last_error"]
    assert "6000 tokens" in job_row(conn, job)["last_error"]  # the detail stays for admins
