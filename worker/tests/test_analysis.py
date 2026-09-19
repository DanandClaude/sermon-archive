"""Merging, main-text choice, quote timing and the whole analysis, with a scripted analyzer."""

from __future__ import annotations

from test_parser import transcript  # noqa: F401  (also used below to build segments)

from sermon_worker.analysis import (
    Addition,
    AnalyzerInput,
    AnalyzerOutput,
    FakeAnalyzer,
    Passage,
    clean_summary,
    clean_title,
    clean_topics,
    flag_main,
    locate_quote,
    merge_passages,
    pick_main,
    run_analysis,
)
from sermon_worker.parser import flatten
from sermon_worker.scripture import Reference, format_reference


def segments_from(text: str, gap: float = 0.5) -> list[dict]:
    """One segment per sentence, with `@90` jumping the clock, like resegmented Whisper output."""
    segs: list[dict] = []
    now, current = 0.0, []
    for raw in text.split():
        if raw.startswith("@"):
            now = float(raw[1:])
            continue
        current.append({"w": raw, "start": now, "end": now + gap * 0.8, "prob": 0.95})
        now += gap
        if raw.endswith((".", "?", "!")):
            segs.append(_seg(current))
            current = []
    if current:
        segs.append(_seg(current))
    return segs


def _seg(words: list[dict]) -> dict:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": " ".join(w["w"] for w in words),
        "words": words,
    }


class Scripted:
    name, model, prompt_version = "scripted", "scripted-1", "t1"

    def __init__(self, **output):
        self.output = AnalyzerOutput(**output)
        self.seen: AnalyzerInput | None = None

    def analyze(self, data):
        self.seen = data
        return self.output


def analyse(text, analyzer=None, **kw):
    kw = {
        "duration_sec": 2700, "speaker": "Pastor Lee", "label_scripture": None,
        "recorded_on": None, **kw,
    }  # fmt: skip
    return run_analysis(analyzer or FakeAnalyzer(), segments_from(text), **kw)


def P(book, chapter, vs=None, ve=None, at=0.0, conf=0.9, note=None):
    return Passage(Reference(book, chapter, vs, ve), at, conf, "parser", note)


class TestMerge:
    def test_repeat_mentions_in_a_cluster_become_one_at_the_earliest_time(self):
        merged = merge_passages(
            [
                P("Hebrews", 13, 17, at=1200),
                P("Hebrews", 13, 17, at=1290),
                P("Hebrews", 13, 17, at=1400),
            ]
        )
        assert [(p.spoken_at, p.mentions) for p in merged] == [(1200, 3)]

    def test_a_mention_after_a_long_gap_is_a_new_entry(self):
        merged = merge_passages([P("Hebrews", 13, 17, at=100), P("Hebrews", 13, 17, at=900)])
        assert [p.spoken_at for p in merged] == [100, 900]

    def test_different_passages_stay_separate_and_come_out_in_time_order(self):
        merged = merge_passages([P("Romans", 8, 28, at=500), P("Hebrews", 13, 17, at=100)])
        assert [format_reference(p.ref) for p in merged] == ["Hebrews 13:17", "Romans 8:28"]

    def test_a_verse_inside_a_range_just_read_is_absorbed(self):
        merged = merge_passages([P("Romans", 8, 28, 39, at=100), P("Romans", 8, 31, at=160)])
        assert [format_reference(p.ref) for p in merged] == ["Romans 8:28–39"]
        assert merged[0].mentions == 2

    def test_a_verse_outside_the_range_is_not(self):
        merged = merge_passages([P("Romans", 8, 28, 30, at=100), P("Romans", 8, 35, at=160)])
        assert len(merged) == 2

    def test_a_chapter_announced_just_before_its_verses_is_one_passage_from_the_announcement(self):
        merged = merge_passages([P("Hebrews", 13, at=100), P("Hebrews", 13, 17, at=130)])
        assert [(format_reference(p.ref), p.spoken_at) for p in merged] == [("Hebrews 13:17", 100)]

    def test_a_whole_chapter_with_no_verses_soon_after_stays(self):
        merged = merge_passages([P("Psalms", 23, at=100), P("Psalms", 23, 4, at=400)])
        assert len(merged) == 2

    def test_the_best_confidence_and_first_note_are_kept(self):
        merged = merge_passages(
            [
                P("John", 3, 16, at=10, conf=0.4),
                P("John", 3, 16, at=20, conf=0.9, note="God so loved"),
            ]
        )
        assert (merged[0].confidence, merged[0].note) == (0.9, "God so loved")


class TestMain:
    def test_the_first_specific_passage_in_the_opening_is_the_main_text(self):
        ps = [P("Romans", 8, at=30), P("Hebrews", 13, 17, at=100), P("John", 3, 16, at=2000)]
        assert format_reference(pick_main(ps, 2700)) == "Hebrews 13:17"

    def test_without_an_opening_passage_the_most_mentioned_wins(self):
        a, b = P("John", 3, 16, at=1500), P("Romans", 8, 28, at=2000)
        b.mentions = 3
        assert format_reference(pick_main([a, b], 2700)) == "Romans 8:28"

    def test_no_passages_no_main_text(self):
        assert pick_main([], 2700) is None

    def test_only_the_first_matching_passage_is_flagged(self):
        ps = [P("Hebrews", 13, 17, at=10), P("Hebrews", 13, 17, at=900), P("John", 3, 16, at=20)]
        flag_main(ps, Reference("Hebrews", 13, 17))
        assert [p.is_main for p in ps] == [True, False, False]
        flag_main(ps, None)
        assert not any(p.is_main for p in ps)


class TestQuotes:
    def test_finds_when_a_phrase_was_said(self):
        t = flatten(segments_from("So we begin. @600 Let us turn to Hebrews now."))
        assert locate_quote(t, "turn to Hebrews") == 601.0

    def test_ignores_case_and_punctuation(self):
        t = flatten(segments_from("Well, TURN to Hebrews, thirteen."))
        assert locate_quote(t, "turn to hebrews thirteen") is not None

    def test_a_phrase_that_was_not_said_has_no_time(self):
        t = flatten(segments_from("Turn to Hebrews now."))
        assert locate_quote(t, "open your Bibles to Psalms") is None
        assert locate_quote(t, "Hebrews") is None  # too short to be a reliable quote


class TestCleaning:
    def test_titles_lose_quotes_colons_and_trailing_stops(self):
        assert (
            clean_title(' "Submitting to Leaders: Hebrews 13." ')
            == "Submitting to Leaders Hebrews 13"
        )
        assert clean_title("") is None and clean_title(None) is None

    def test_long_titles_are_cut_at_a_word(self):
        assert len(clean_title("word " * 40)) <= 80

    def test_topics_are_trimmed_deduplicated_and_limited(self):
        assert clean_topics([" Trust ", "trust", "", "x" * 41, "a", "b", "c", "d", "e"]) == [
            "Trust", "a", "b", "c", "d",
        ]  # fmt: skip

    def test_a_topic_never_repeats_a_book_testament_or_genre_tag(self):
        assert clean_topics(["Hebrews", "Apostasy", "epistle", "New Testament", "1 John"]) == [
            "Apostasy"
        ]

    def test_summary_is_capped(self):
        assert len(clean_summary("word " * 1000)) <= 2000
        assert clean_summary("   ") is None


class TestRunAnalysis:
    SAID = (
        "Good morning. Turn with me to Hebrews thirteen verse seventeen. @60 "
        "Now in verse seventeen he says obey them that have the rule over you. @900 "
        "First Peter chapter five verses two and three tells elders the same."
    )

    def test_finds_spoken_passages_with_times_and_a_main_text(self):
        result = analyse(self.SAID)
        assert [(format_reference(p.ref), round(p.spoken_at)) for p in result.passages] == [
            ("Hebrews 13:17", 3),
            ("1 Peter 5:2–3", 900),
        ]
        assert format_reference(result.primary) == "Hebrews 13:17"
        assert [p.is_main for p in result.passages] == [True, False]

    def test_the_repeated_verse_joins_the_first_mention(self):
        result = analyse(self.SAID)
        assert result.passages[0].mentions == 2

    def test_the_tape_label_beats_anything_detected(self):
        result = analyse(self.SAID, label_scripture="Romans 8:28-39")
        assert format_reference(result.primary) == "Romans 8:28–39"
        assert not any(
            p.is_main for p in result.passages
        )  # the label passage was never named aloud

    def test_an_unreadable_label_is_ignored(self):
        result = analyse(self.SAID, label_scripture="see box 3")
        assert format_reference(result.primary) == "Hebrews 13:17"

    def test_a_label_naming_a_spoken_passage_flags_it(self):
        result = analyse(self.SAID, label_scripture="1 Peter 5:2-3")
        assert [p.is_main for p in result.passages] == [False, True]

    def test_the_fake_analyzer_writes_an_honest_placeholder(self):
        result = analyse(self.SAID)
        assert result.title == "Sermon on Hebrews 13"
        assert "fake analyzer" in result.summary
        assert result.topics == []
        assert result.passages[0].note.startswith("and he says") or result.passages[0].note

    def test_the_fake_analyzer_says_so_when_it_found_nothing(self):
        assert analyse("Just some words about grace.").title == "Untitled sermon"

    def test_the_analyzer_is_shown_the_candidates_the_label_and_the_timed_text(self):
        scripted = Scripted(title="T")
        analyse(self.SAID, scripted, label_scripture="Jude 3", recorded_on="1988-03-13")
        seen = scripted.seen
        assert [c.reference for c in seen.candidates] == [
            "Hebrews 13:17", "Hebrews 13:17", "1 Peter 5:2–3",
        ]  # fmt: skip
        assert seen.candidates[0].said == "Hebrews thirteen verse seventeen"
        assert format_reference(seen.label_passage) == "Jude 1:3"
        assert seen.recorded_on == "1988-03-13"
        assert seen.timed_text.splitlines()[0].startswith("[0:00] Good morning.")

    def test_passages_the_analyzer_rejects_are_dropped(self):
        result = analyse(
            "Job 5 years ago we met. Then Acts chapter 2 verse 38.",
            Scripted(rejected={"c1"}),
        )
        assert [format_reference(p.ref) for p in result.passages] == ["Acts 2:38"]

    def test_a_guessed_chapter_can_be_corrected_by_the_analyzer(self):
        said = (
            "Turn to Hebrews chapter 13 verse 17 @60 and back in verse seven of this same chapter."
        )
        result = analyse(said, Scripted())
        assert [(format_reference(p.ref)) for p in result.passages] == [
            "Hebrews 13:17",
            "Hebrews 13:7",
        ]
        scripted = Scripted(corrected={"c2": Reference("Hebrews", 12, 7)})
        result = analyse(said, scripted)
        assert [c.relative for c in scripted.seen.candidates] == [False, True]
        assert [(format_reference(p.ref)) for p in result.passages] == [
            "Hebrews 13:17",
            "Hebrews 12:7",
        ]

    def test_an_impossible_correction_is_ignored(self):
        said = "Turn to Hebrews chapter 13 verse 17 @60 and back in verse seven."
        result = analyse(said, Scripted(corrected={"c2": Reference("Hebrews", 99, 7)}))
        assert [(format_reference(p.ref)) for p in result.passages] == [
            "Hebrews 13:17",
            "Hebrews 13:7",
        ]

    def test_notes_are_attached_and_trimmed(self):
        result = analyse(self.SAID, Scripted(notes={"c1": "x" * 300}))
        assert len(result.passages[0].note) == 200

    def test_a_passage_only_the_model_found_is_added_at_the_quoted_time(self):
        text = "Now @1000 open your bibles to the book of Habakuk chapter two and read along."
        result = analyse(
            text,
            Scripted(
                additions=[
                    Addition(
                        Reference("Habakkuk", 2, 1, 4),
                        "the book of Habakuk chapter two",
                        "the watchtower",
                    )
                ]
            ),
        )
        assert [(format_reference(p.ref), p.source, p.spoken_at) for p in result.passages] == [
            ("Habakkuk 2:1–4", "model", 1002.0)
        ]

    def test_model_findings_that_cannot_be_checked_are_left_out(self):
        text = "Open your bibles to Habakuk chapter two and read along together."
        result = analyse(
            text,
            Scripted(
                additions=[
                    Addition(
                        Reference("Habakkuk", 9, 1), "Habakuk chapter two", None
                    ),  # no such chapter
                    Addition(
                        Reference("Habakkuk", 2, 1), "words never said aloud", None
                    ),  # not in the recording
                    Addition(
                        Reference("Hezekiah", 2, 1), "Habakuk chapter two", None
                    ),  # not a book
                ]
            ),
        )
        assert result.passages == []

    def test_the_model_can_choose_the_main_text_but_only_if_it_is_valid(self):
        result = analyse(self.SAID, Scripted(primary_passage=Reference("1 Peter", 5, 2, 3)))
        assert format_reference(result.primary) == "1 Peter 5:2–3"
        result = analyse(self.SAID, Scripted(primary_passage=Reference("1 Peter", 50)))
        assert format_reference(result.primary) == "Hebrews 13:17"

    def test_regenerating_the_summary_asks_for_nothing_else(self):
        scripted = Scripted(summary="A new summary.")
        result = analyse(self.SAID, scripted, only="summary")
        assert scripted.seen.candidates == []
        assert (result.summary, result.passages, result.primary) == ("A new summary.", [], None)

    def test_titles_and_topics_from_the_analyzer_are_cleaned(self):
        result = analyse(
            "Hello there.", Scripted(title='"Trusting: God."', topics=["Trust", "trust", " Faith "])
        )
        assert (result.title, result.topics) == ("Trusting God", ["Trust", "Faith"])
