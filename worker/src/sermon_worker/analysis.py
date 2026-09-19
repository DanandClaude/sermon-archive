"""Turns a transcript into a title, summary, topic tags and a list of named passages.

The deterministic parser proposes passages; an analyzer (a language model, or the fake one used in
development and tests) judges them and writes the title and summary; every passage is then checked
against the canon, merged with repeat mentions, and given a time. Nothing here touches the
database, so it can be tested with plain data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from .parser import Candidate, Transcript, find_references, flatten
from .scripture import (
    Invalid,
    Reference,
    book_names,
    canon,
    format_reference,
    parse_reference_text,
    try_validate,
)

# "Turn to Hebrews 13 ... verse 17" is one passage, announced first and then read.
PREAMBLE_SEC = 45.0

MAX_TITLE_CHARS = 80
MAX_TOPICS = 5
MAX_TOPIC_CHARS = 40
MAX_SUMMARY_CHARS = 2000

CONFIDENCE = {"high": 0.9, "medium": 0.7, "low": 0.4}
MODEL_CONFIDENCE = 0.8


class AnalysisError(Exception):
    """The analyzer's answer could not be used. Trying again may help."""


@dataclass
class CandidateView:
    """A passage the parser proposes, with the words around it, as an analyzer sees it."""

    id: str
    reference: str
    spoken_at: float
    confidence: str
    said: str  # exactly as spoken, e.g. "Hebrews thirteen seventeen"
    context: str  # words before and after
    relative: bool  # the book and chapter were guessed from the passage named just before
    after: str  # the few words that follow, a natural context note


@dataclass
class AnalyzerInput:
    timed_text: str  # "[m:ss] sentence" per line
    plain_text: str
    duration_sec: float | None
    speaker: str | None
    label_passage: Reference | None
    recorded_on: str | None
    candidates: list[CandidateView]
    # Topic tags already in use, so new sermons reuse them (SPEC §4.3).
    known_topics: list[str] = field(default_factory=list)
    # "summary" asks only for a new summary (the reviewer pressed Regenerate).
    only: str | None = None


@dataclass
class Addition:
    """A passage the parser missed, found by the model. `quote` is words from the transcript."""

    ref: Reference
    quote: str
    note: str | None = None


@dataclass
class AnalyzerOutput:
    title: str | None = None
    summary: str | None = None
    topics: list[str] = field(default_factory=list)
    primary_passage: Reference | None = None
    notes: dict[str, str] = field(default_factory=dict)  # candidate id -> short context note
    rejected: set[str] = field(default_factory=set)  # candidate ids that are not references
    corrected: dict[str, Reference] = field(default_factory=dict)  # candidate id -> right passage
    additions: list[Addition] = field(default_factory=list)
    raw: dict = field(default_factory=dict)  # kept on the record for debugging


class Analyzer(Protocol):
    name: str
    model: str
    prompt_version: str

    def analyze(self, data: AnalyzerInput) -> AnalyzerOutput: ...


@dataclass
class Passage:
    ref: Reference
    spoken_at: float
    confidence: float
    source: str  # "parser" or "model": both are stored as auto
    note: str | None = None
    mentions: int = 1
    is_main: bool = False


@dataclass
class Analysis:
    title: str | None
    summary: str | None
    topics: list[str]
    passages: list[Passage]
    primary: Reference | None
    output: AnalyzerOutput


# -- text helpers ----------------------------------------------------------------------------


def clock(seconds: float) -> str:
    total = int(seconds)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def timed_text(segments: list[dict]) -> str:
    return "\n".join(
        f"[{clock(s['start'])}] {s['text'].strip()}" for s in segments if s["text"].strip()
    )


def clean_title(title: str | None) -> str | None:
    """Short, plain and safe to make a file name from: no quotes, no colons, no trailing full stop."""
    if not title:
        return None
    text = re.sub(r"\s*:\s*", " ", re.sub(r"[\"“”‘’`]+", "", title))
    text = re.sub(r"\s+", " ", text).strip(" .-–—")
    if len(text) > MAX_TITLE_CHARS:
        text = text[:MAX_TITLE_CHARS].rsplit(" ", 1)[0]
    return text or None


def _passage_tag_names() -> set[str]:
    """Names the passage tags already cover, so a topic never repeats one (a "Hebrews" topic
    beside the "Hebrews" book tag)."""
    names = {n.lower() for n in book_names()}
    names |= {f"{t} testament".lower() for t in ("Old", "New")} | {"old testament", "new testament"}
    names |= {b.genre.lower() for b in canon()}
    return names


def clean_topics(topics: list[str]) -> list[str]:
    seen: set[str] = _passage_tag_names()
    out: list[str] = []
    for topic in topics:
        text = re.sub(r"\s+", " ", str(topic)).strip(' .,;:"“”')
        if not text or len(text) > MAX_TOPIC_CHARS or text.lower() in seen:
            continue
        seen.add(text.lower())
        out.append(text)
    return out[:MAX_TOPICS]


def clean_summary(summary: str | None) -> str | None:
    text = re.sub(r"[ \t]+", " ", (summary or "").strip())
    return (
        text[:MAX_SUMMARY_CHARS].rsplit(" ", 1)[0]
        if len(text) > MAX_SUMMARY_CHARS
        else text or None
    )


# -- locating a quoted phrase ----------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def locate_quote(transcript: Transcript, quote: str) -> float | None:
    """When a phrase was said, or None if those words are not in the transcript."""
    wanted = _WORD.findall(quote.lower())[:12]
    if len(wanted) < 2:
        return None
    heard = [_WORD.findall(w.lower()) for w in transcript.words]
    flat: list[tuple[str, int]] = [(p, i) for i, parts in enumerate(heard) for p in parts]
    for start in range(len(flat) - len(wanted) + 1):
        if all(flat[start + k][0] == wanted[k] for k in range(len(wanted))):
            return transcript.starts[flat[start][1]]
    return None


# -- merging ---------------------------------------------------------------------------------


def _key(ref: Reference) -> tuple:
    return (ref.book, ref.chapter, ref.verse_start, ref.verse_end)


def _covers(outer: Reference, inner: Reference) -> bool:
    """The outer passage already includes the inner one: verses inside a listed range, or a whole
    chapter named after verses of it were listed."""
    if (outer.book, outer.chapter) != (inner.book, inner.chapter) or outer.verse_start is None:
        return False
    if inner.verse_start is None:
        return True  # "Hebrews 5" again, after Hebrews 5:11–12
    outer_end = outer.verse_end or outer.verse_start
    inner_end = inner.verse_end or inner.verse_start
    return outer.verse_start <= inner.verse_start and inner_end <= outer_end


def covers_or_equals(earlier: Reference, later: Reference) -> bool:
    """The later mention adds nothing: the same passage, verses inside a range already listed, or the
    whole chapter named after some of its verses were listed."""
    return _key(earlier) == _key(later) or _covers(earlier, later)


def merge_passages(passages: list[Passage]) -> list[Passage]:
    """One entry per passage, at the earliest time it was named, in the order spoken.

    A passage named again later, however much later, is the same passage. So are verses inside a
    range that was already listed (Hebrews 6:6 after Hebrews 6:4–6), and a whole chapter named
    after verses of it were listed (Hebrews 5 after Hebrews 5:11–12).
    """
    out: list[Passage] = []
    for p in sorted(passages, key=lambda p: p.spoken_at):
        home = next((q for q in out if covers_or_equals(q.ref, p.ref)), None)
        if home is None:
            out.append(p)
            continue
        home.mentions += p.mentions
        home.confidence = max(home.confidence, p.confidence)
        home.note = home.note or p.note

    # A whole chapter announced just before its verses are read is one passage: the verses, from
    # the moment the chapter was announced.
    result: list[Passage] = []
    for i, p in enumerate(out):
        if p.ref.verse_start is None:
            follower = next(
                (
                    q
                    for q in out[i + 1 :]
                    if q.spoken_at - p.spoken_at <= PREAMBLE_SEC
                    and (q.ref.book, q.ref.chapter) == (p.ref.book, p.ref.chapter)
                    and q.ref.verse_start is not None
                ),
                None,
            )
            if follower is not None:
                follower.spoken_at = p.spoken_at
                follower.mentions += p.mentions
                follower.note = follower.note or p.note
                continue
        result.append(p)
    return sorted(result, key=lambda p: p.spoken_at)


def pick_main(passages: list[Passage], duration_sec: float | None) -> Reference | None:
    """The passage announced early on, else the one mentioned most."""
    if not passages:
        return None
    early = (duration_sec or 3000) * 0.2
    opening = [p for p in passages if p.spoken_at <= early and p.confidence >= CONFIDENCE["medium"]]
    if opening:
        specific = [p for p in opening if p.ref.verse_start is not None]
        return (specific or opening)[0].ref
    best = max(passages, key=lambda p: (p.mentions, -p.spoken_at))
    return best.ref


def flag_main(passages: list[Passage], primary: Reference | None) -> None:
    """Exactly one passage, the first spoken that matches the primary passage, is the main text."""
    for p in passages:
        p.is_main = False
    if primary is None:
        return
    for p in passages:
        if _key(p.ref) == _key(primary):
            p.is_main = True
            return


# -- the whole analysis ----------------------------------------------------------------------


def _after(transcript: Transcript, c: Candidate, count: int) -> str:
    end = transcript.toks[c.last].wi
    return " ".join(transcript.words[end + 1 : end + 1 + count])


def run_analysis(
    analyzer: Analyzer,
    segments: list[dict],
    *,
    duration_sec: float | None,
    speaker: str | None,
    label_scripture: str | None,
    recorded_on: str | None,
    known_topics: list[str] | None = None,
    only: str | None = None,
) -> Analysis:
    transcript = flatten(segments)
    candidates = [] if only == "summary" else find_references(transcript)
    label: Reference | None = None
    if label_scripture and label_scripture.strip():
        try:
            label = parse_reference_text(label_scripture)
        except Invalid:
            label = None  # an unreadable label is not an error; the reviewer can fix it

    views = [
        CandidateView(
            c.id, format_reference(c.ref), c.spoken_at, c.confidence, c.text,
            transcript.snippet(c.first, c.last, before=15, after=30), c.relative,
            _after(transcript, c, 12),
        )
        for c in candidates
    ]  # fmt: skip
    data = AnalyzerInput(
        timed_text=timed_text(segments),
        plain_text=" ".join(s["text"].strip() for s in segments if s["text"].strip()),
        duration_sec=duration_sec,
        speaker=speaker,
        label_passage=label,
        recorded_on=recorded_on,
        candidates=views,
        known_topics=known_topics or [],
        only=only,
    )
    output = analyzer.analyze(data)

    passages: list[Passage] = []
    for c in candidates:
        if c.id in output.rejected:
            continue
        note = output.notes.get(c.id)
        fixed = output.corrected.get(c.id)
        ref = (
            fixed and try_validate(fixed.book, fixed.chapter, fixed.verse_start, fixed.verse_end)
        ) or c.ref
        passages.append(
            Passage(ref, c.spoken_at, CONFIDENCE[c.confidence], "parser", note[:200] if note else None)
        )  # fmt: skip
    for add in output.additions:
        ref = try_validate(add.ref.book, add.ref.chapter, add.ref.verse_start, add.ref.verse_end)
        when = locate_quote(transcript, add.quote)
        if ref is None or when is None:
            continue  # cannot be checked against the canon or the recording, so it is not listed
        passages.append(
            Passage(ref, when, MODEL_CONFIDENCE, "model", add.note[:200] if add.note else None)
        )  # fmt: skip
    passages = merge_passages(passages)

    # The tape label, typed by a person, outranks anything detected.
    primary = label
    if primary is None and output.primary_passage is not None:
        primary = try_validate(
            output.primary_passage.book, output.primary_passage.chapter,
            output.primary_passage.verse_start, output.primary_passage.verse_end,
        )  # fmt: skip
    if primary is None:
        primary = pick_main(passages, duration_sec)
    flag_main(passages, primary)

    return Analysis(
        title=clean_title(output.title),
        summary=clean_summary(output.summary),
        topics=clean_topics(output.topics),
        passages=passages,
        primary=primary,
        output=output,
    )


# -- the fake analyzer -----------------------------------------------------------------------


class FakeAnalyzer:
    """A stand-in that needs no account and no network, so the whole pipeline can be tried and
    tested. Its title and summary are placeholders, and it says so. It is refused in production."""

    name = "fake"
    model = "fake"
    prompt_version = "fake-1"

    def analyze(self, data: AnalyzerInput) -> AnalyzerOutput:
        best = next((c for c in data.candidates if c.confidence == "high"), None) or (
            data.candidates[0] if data.candidates else None
        )
        opening = " ".join(data.plain_text.split()[:25])
        summary = f"Placeholder summary from the fake analyzer. The recording begins: “{opening}…”"
        if data.only == "summary":
            return AnalyzerOutput(summary=summary, raw={"fake": True, "only": "summary"})
        title = f"Sermon on {best.reference.split(':')[0]}" if best else "Untitled sermon"
        return AnalyzerOutput(
            title=title,
            summary=summary,
            topics=[],
            notes={c.id: c.after for c in data.candidates if c.after},
            rejected={c.id for c in data.candidates if c.confidence == "low"},
            raw={"fake": True, "candidates": len(data.candidates)},
        )
