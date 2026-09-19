"""The canon, the typed-reference reader, and the shared cases the TypeScript app also passes."""

from __future__ import annotations

import json

import pytest

from sermon_worker import scripture
from sermon_worker.pipeline import shared_dir
from sermon_worker.scripture import (
    Invalid,
    Reference,
    format_reference,
    parse_reference_text,
    resolve_book,
    tags_for_book,
    validate_reference,
)

CASES = json.loads((shared_dir() / "reference-cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["text"] or "(empty)" for c in CASES])
def test_matches_the_shared_cases(case):
    if case["ok"]:
        assert parse_reference_text(case["text"]).as_json() == case["ref"]
    else:
        with pytest.raises(Invalid) as error:
            parse_reference_text(case["text"])
        assert str(error.value) == case["error"]


def test_the_canon_has_66_books_1189_chapters_and_31102_verses():
    books = scripture.canon()
    assert len(books) == 66
    assert sum(len(b.chapters) for b in books) == 1189
    assert sum(sum(b.chapters) for b in books) == 31102


def test_every_book_is_reachable_by_its_own_name_in_speech():
    for book in scripture.canon():
        assert resolve_book(book.name, abbreviations=False) == book


def test_abbreviations_work_when_typed_but_not_in_speech():
    assert resolve_book("Heb").name == "Hebrews"
    assert resolve_book("Heb", abbreviations=False) is None
    assert resolve_book("ex", abbreviations=False) is None


@pytest.mark.parametrize(
    ("spoken", "name"),
    [
        ("First John", "1 John"),
        ("2nd Timothy", "2 Timothy"),
        ("3 John", "3 John"),
        ("1Peter", "1 Peter"),
    ],
)
def test_numbered_books_however_the_number_is_written(spoken, name):
    assert resolve_book(spoken).name == name


def test_validation_says_what_is_wrong():
    with pytest.raises(Invalid, match="has 16 chapters"):
        validate_reference("Romans", 17)
    with pytest.raises(Invalid, match="has 39 verses"):
        validate_reference("Romans", 8, 40)
    with pytest.raises(Invalid, match="can’t come before"):
        validate_reference("Romans", 8, 20, 10)
    with pytest.raises(Invalid, match="starting verse"):
        validate_reference("Romans", 8, None, 10)


def test_a_range_that_ends_where_it_starts_is_a_single_verse():
    assert validate_reference("John", 3, 16, 16) == Reference("John", 3, 16, None)


def test_formats_the_way_the_mockups_do():
    assert format_reference(Reference("Psalms", 23)) == "Psalm 23"
    assert format_reference(Reference("Romans", 8, 28, 39)) == "Romans 8:28–39"
    assert format_reference(Reference("1 Peter", 5, 2, 3)) == "1 Peter 5:2–3"
    assert format_reference(Reference("Hebrews", 13, 17)) == "Hebrews 13:17"


def test_tags_carry_testament_genre_and_book():
    assert tags_for_book("Hebrews") == [
        ("testament", "New Testament"),
        ("genre", "Epistle"),
        ("book", "Hebrews"),
    ]
    assert tags_for_book("Nonsense") == []
