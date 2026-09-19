"""Hiding repeated scripture references on sermons analysed before repeats were merged."""

from __future__ import annotations

import json

from conftest import make_sermon

from sermon_worker.tidy import dedupe_all, dedupe_refs


def add_ref(conn, sermon, book, chapter, vs, ve, at, source="auto", edited=False, main=False):
    return conn.execute(
        "INSERT INTO scripture_refs (sermon_id, book, chapter, verse_start, verse_end, spoken_at_sec, "
        "source, edited_at, is_main_text) VALUES (%s, %s, %s, %s, %s, %s, %s::ref_source, "
        "CASE WHEN %s THEN now() END, %s) RETURNING id",
        (sermon, book, chapter, vs, ve, at, source, edited, main),
    ).fetchone()["id"]


def live(conn, sermon):
    return [
        (r["book"], r["chapter"], r["verse_start"], r["verse_end"], r["spoken_at_sec"])
        for r in conn.execute(
            "SELECT * FROM scripture_refs WHERE sermon_id = %s AND deleted_at IS NULL "
            "ORDER BY spoken_at_sec",
            (sermon,),
        ).fetchall()
    ]


def test_keeps_the_first_of_a_repeated_passage_and_hides_the_rest(conn):
    s = make_sermon(conn, "needs_review")
    for at in (682, 827, 2008):
        add_ref(conn, s, "Hebrews", 6, 6, None, at)
    add_ref(conn, s, "Romans", 8, 28, None, 900)
    assert dedupe_refs(conn, s) == 2
    assert live(conn, s) == [("Hebrews", 6, 6, None, 682), ("Romans", 8, 28, None, 900)]


def test_hides_verses_inside_a_range_listed_earlier_but_not_the_reverse(conn):
    s = make_sermon(conn, "needs_review")
    add_ref(conn, s, "Hebrews", 6, 4, 6, 142)
    add_ref(conn, s, "Hebrews", 6, 6, None, 2008)
    add_ref(conn, s, "Romans", 8, 28, None, 100)
    add_ref(conn, s, "Romans", 8, 28, 30, 900)
    dedupe_refs(conn, s)
    assert live(conn, s) == [
        ("Romans", 8, 28, None, 100),
        ("Hebrews", 6, 4, 6, 142),
        ("Romans", 8, 28, 30, 900),
    ]


def test_never_hides_something_a_person_added_or_corrected(conn):
    s = make_sermon(conn, "needs_review")
    add_ref(conn, s, "John", 3, 16, None, 100)
    add_ref(conn, s, "John", 3, 16, None, 200, source="manual")
    add_ref(conn, s, "John", 3, 16, None, 300, edited=True)
    assert dedupe_refs(conn, s) == 0
    assert len(live(conn, s)) == 3


def test_leaves_already_hidden_ones_alone_and_is_safe_to_repeat(conn):
    s = make_sermon(conn, "needs_review")
    add_ref(conn, s, "John", 3, 16, None, 100)
    add_ref(conn, s, "John", 3, 16, None, 200)
    assert dedupe_refs(conn, s) == 1
    assert dedupe_refs(conn, s) == 0
    assert (
        conn.execute(
            "SELECT count(*) AS n FROM scripture_refs WHERE deleted_at IS NOT NULL"
        ).fetchone()["n"]
        == 1
    )


def test_the_main_text_stays_on_exactly_one_entry(conn):
    s = make_sermon(conn, "needs_review")
    conn.execute(
        "UPDATE sermons SET primary_passage = %s WHERE id = %s",
        (json.dumps({"book": "Hebrews", "chapter": 6, "verseStart": 6, "verseEnd": None}), s),
    )
    add_ref(conn, s, "Hebrews", 6, 6, None, 100)
    add_ref(conn, s, "Hebrews", 6, 6, None, 900, main=True)
    dedupe_refs(conn, s)
    rows = conn.execute(
        "SELECT spoken_at_sec, is_main_text FROM scripture_refs WHERE deleted_at IS NULL"
    ).fetchall()
    assert rows == [{"spoken_at_sec": 100.0, "is_main_text": True}]


def test_records_what_it_did_and_covers_every_sermon(conn):
    a, b = make_sermon(conn, "needs_review"), make_sermon(conn, "approved")
    for s in (a, b):
        add_ref(conn, s, "John", 3, 16, None, 1)
        add_ref(conn, s, "John", 3, 16, None, 2)
    deleted = make_sermon(conn, "needs_review", deleted=True)
    add_ref(conn, deleted, "John", 3, 16, None, 1)
    add_ref(conn, deleted, "John", 3, 16, None, 2)
    assert dedupe_all(conn) == {a: 1, b: 1}
    entries = conn.execute(
        "SELECT actor_id, diff FROM audit_log WHERE action = 'scripture.dedupe'"
    ).fetchall()
    assert [(e["actor_id"], e["diff"]) for e in entries] == [(None, {"hidden": 1})] * 2


def test_folds_a_whole_chapter_into_verses_of_it_listed_earlier(conn):
    s = make_sermon(conn, "needs_review")
    add_ref(conn, s, "Hebrews", 5, 11, 12, 117)
    add_ref(conn, s, "Hebrews", 5, None, None, 2075)
    add_ref(conn, s, "Hebrews", 12, None, None, 2227)
    add_ref(conn, s, "James", 4, None, None, 100)
    add_ref(conn, s, "James", 4, 4, None, 200)  # the whole chapter came first: both stay
    dedupe_refs(conn, s)
    assert live(conn, s) == [
        ("James", 4, None, None, 100),
        ("Hebrews", 5, 11, 12, 117),
        ("James", 4, 4, None, 200),
        ("Hebrews", 12, None, None, 2227),
    ]
