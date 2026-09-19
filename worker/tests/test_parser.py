"""Finding named passages in word-timed text: spoken forms, digits, relative verses and pitfalls."""

from __future__ import annotations

import pytest

from sermon_worker.parser import find_references, flatten
from sermon_worker.scripture import format_reference


def transcript(text: str, gap: float = 0.5):
    """One segment from plain text. `@90` in the text jumps the clock to 90 seconds."""
    words, now = [], 0.0
    for raw in text.split():
        if raw.startswith("@"):
            now = float(raw[1:])
            continue
        words.append({"w": raw, "start": now, "end": now + gap * 0.8, "prob": 0.95})
        now += gap
    return flatten([{"start": 0, "end": now, "text": text, "words": words}])


def refs(text: str) -> list[str]:
    return [format_reference(c.ref) for c in find_references(transcript(text))]


@pytest.mark.parametrize(
    ("said", "expected"),
    [
        # digits, as Whisper usually writes them
        ("Turn with me to Hebrews 13:17 this morning", ["Hebrews 13:17"]),
        ("Hebrews 13:17-19 says", ["Hebrews 13:17–19"]),
        ("Look at Psalm 23 for a moment", ["Psalm 23"]),
        ("In Psalms 119:105 we read", ["Psalm 119:105"]),
        ("First Peter 5:2-3 tells elders", ["1 Peter 5:2–3"]),
        ("Turn to 1 John 3:16", ["1 John 3:16"]),
        ("Second Timothy 3:16 all scripture", ["2 Timothy 3:16"]),
        ("Song of Solomon 2:1 the rose of Sharon", ["Song of Solomon 2:1"]),
        ("Song of Songs 2:1", ["Song of Solomon 2:1"]),
        # spoken numbers
        ("Romans thirteen one and two", ["Romans 13:1–2"]),
        ("First Peter chapter five verses two and three", ["1 Peter 5:2–3"]),
        ("turn to Psalm twenty-three", ["Psalm 23"]),
        ("turn to Psalm twenty three", ["Psalm 23"]),
        ("Acts chapter nine verses twenty six and twenty seven", ["Acts 9:26–27"]),
        ("Hebrews chapter thirteen verse seventeen", ["Hebrews 13:17"]),
        ("Hebrews thirteen seventeen", ["Hebrews 13:17"]),
        (
            "Psalm one hundred nineteen verse one hundred five",
            ["Psalms 119:105".replace("Psalms", "Psalm")],
        ),
        ("Psalm one hundred and nineteen", ["Psalm 119"]),
        ("John chapter three verse sixteen through eighteen", ["John 3:16–18"]),
        ("Matthew five verses one through twelve", ["Matthew 5:1–12"]),
        # ranges
        ("John 3:16 to 18", ["John 3:16–18"]),
        ("Romans 8:28 through 39", ["Romans 8:28–39"]),
        ("Romans 8:1 and 2 says", ["Romans 8:1–2"]),
        # one-chapter books
        ("Jude verse 3 says contend for the faith", ["Jude 3".replace("Jude 3", "Jude 1:3")]),
        ("turn to Jude 3", ["Jude 1:3"]),
        ("Third John verse four", ["3 John 1:4"]),
        ("Obadiah 15", ["Obadiah 1:15"]),
    ],
)
def test_reads_what_was_named(said, expected):
    assert refs(said) == expected


def test_reports_the_time_the_book_was_first_said():
    found = find_references(transcript("So as I was saying @1258 turn to Hebrews 13:17 today"))
    assert [c.spoken_at for c in found] == [1258.0 + 0.5 * 2]
    assert found[0].text == "Hebrews 13:17"


def test_a_verse_alone_belongs_to_the_passage_named_before():
    found = find_references(
        transcript("Turn to Hebrews chapter 13 @60 and look at verse 17 @70 then in verse seven")
    )
    assert [format_reference(c.ref) for c in found] == [
        "Hebrews 13",
        "Hebrews 13:17",
        "Hebrews 13:7",
    ]
    assert [c.relative for c in found] == [False, True, True]


def test_verses_after_a_named_chapter_in_the_same_breath():
    assert refs("Romans 8 verse 28 through 30 is where we start") == ["Romans 8:28–30"]
    assert refs("Romans 8 and verse 28") == ["Romans 8:28"]


def test_chapter_and_verse_without_the_book_use_the_last_book():
    assert refs("We read Hebrews 13:17 @40 but back in chapter 11 verse 6 it says") == [
        "Hebrews 13:17",
        "Hebrews 11:6",
    ]


def test_a_relative_verse_is_forgotten_after_a_while():
    assert refs("Hebrews 13:17 @400 in verse 5 he said") == ["Hebrews 13:17"]


def test_a_chapter_with_no_verse_and_no_book_is_too_vague():
    assert refs("Hebrews 13:17 and then in chapter 4 we see") == ["Hebrews 13:17"]


def test_an_ordinary_sentence_makes_nothing():
    assert refs("I was thinking about John and Mark and what they said about acts of mercy") == []
    assert refs("Job six months ago he had two jobs and numbers were up 12 percent") == []


def test_i_is_the_pronoun_not_the_numeral():
    assert refs("I John said hello and I Peter") == []


def test_ambiguous_names_need_a_capital_and_something_clearly_a_chapter():
    assert refs("in the acts 2 of the ship") == []
    assert refs("Acts chapter 2 verse 38") == ["Acts 2:38"]
    assert refs("Mark 12:30 says love the Lord") == ["Mark 12:30"]
    found = find_references(transcript("Mark 12 people came"))
    assert [c.confidence for c in found] == ["low"]
    found = find_references(transcript("Mark chapter 12 people came"))
    assert [c.confidence for c in found] == ["high"]
    assert refs("Job 5 years later") == ["Job 5"]  # kept, marked low, for the later passes to judge


def test_impossible_passages_are_dropped_or_narrowed():
    assert refs("Romans 99:1 is not a thing") == []
    assert refs("Hezekiah 3:1") == []
    assert refs("Romans 8:99 hmm") == ["Romans 8"]  # the chapter exists, the verse does not
    assert refs("Jude 40 hmm") == []


def test_a_sentence_end_stops_a_passage():
    assert refs("Turn to Romans. 8 people came with him") == []
    assert refs("We read Psalm 23. Verse 4 says") == ["Psalm 23", "Psalm 23:4"]
    assert refs("Hebrews 13. 17 elders came") == ["Hebrews 13"]


def test_a_comma_stops_the_bare_verse_form_but_not_verse_words():
    assert refs("Look at Psalm 23, 1 of the sheep") == ["Psalm 23"]
    assert refs("Look at Psalm 23, verse 1 says") == ["Psalm 23:1"]


def test_several_passages_in_order_with_their_own_times():
    found = find_references(
        transcript("Romans 8:28 then @900 Hebrews 13:17 and finally Psalm twenty-three")
    )
    assert [(format_reference(c.ref), round(c.spoken_at)) for c in found] == [
        ("Romans 8:28", 0),
        ("Hebrews 13:17", 900),
        ("Psalm 23", 902),
    ]
    assert [c.id for c in found] == ["c1", "c2", "c3"]


def test_a_reference_spread_across_segments_is_still_one_reference():
    segs = [
        {"start": 0, "end": 2, "text": "", "words": [
            {"w": "Turn", "start": 0, "end": 0.4, "prob": 1}, {"w": "to", "start": 0.5, "end": 0.7, "prob": 1},
            {"w": "Hebrews", "start": 1.0, "end": 1.5, "prob": 1}]},
        {"start": 2, "end": 4, "text": "", "words": [
            {"w": "13:17", "start": 2.0, "end": 2.6, "prob": 1}]},
    ]  # fmt: skip
    found = find_references(flatten(segs))
    assert [format_reference(c.ref) for c in found] == ["Hebrews 13:17"]


def test_numbers_glued_to_punctuation_are_split():
    assert refs("(Hebrews 13:17), as we said") == ["Hebrews 13:17"]
    assert refs("Hebrews 13:17–19.") == ["Hebrews 13:17–19"]
    assert refs("Hebrews 13:17-19,") == ["Hebrews 13:17–19"]


def test_no_words_no_references():
    assert find_references(flatten([])) == []
    assert find_references(flatten([{"start": 0, "end": 1, "text": "", "words": []}])) == []
