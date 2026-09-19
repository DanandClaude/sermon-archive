"""Finds the Bible passages a pastor names aloud in a word-timed transcript.

This is the deterministic first pass of scripture detection (SPEC §5). It reads spoken forms
("First Peter chapter five verses two and three", "Hebrews thirteen seventeen") and written ones
("Hebrews 13:17"), follows a passage with "verse 5" or "chapter 4 verse 2" when the book is
understood from before, and checks every result against the canon. It errs toward proposing too
much: the language-model pass and the reviewer remove what is wrong, and only a passage that
survives all three reaches the final list.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .scripture import Book, Reference, find_book, resolve_book, try_validate

# Words that are also ordinary English. These count as a book only when they are capitalised and
# the number that follows is clearly a chapter ("Mark 12 people" is not a reference).
AMBIGUOUS_BOOKS = {"Mark", "Job", "Acts", "Numbers", "Judges", "Kings", "Ruth"}

# After naming a passage, "verse 5" may refer to it again for this long.
RELATIVE_WINDOW_SEC = 300.0

UNITS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9,
}  # fmt: skip
TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}  # fmt: skip
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90,
}  # fmt: skip
VERSE_WORDS = {"verse", "verses"}
RANGE_WORDS = {"to", "through", "thru"}
DASHES = {"-", "–", "—"}

_TOKEN = re.compile(r"\d+(?:st|nd|rd)?|[A-Za-z]+(?:['’][A-Za-z]+)?|[:\-–—]")


@dataclass(slots=True)
class Tok:
    text: str  # as written
    low: str
    kind: str  # "num", "word" or "sep"
    start: float
    end: float
    stop: bool  # the word ended a sentence (. ? ! ;), so a passage cannot run on past it
    pause: bool  # the word ended with any punctuation, comma included
    wi: int  # index of the source word in Transcript.words


@dataclass
class Transcript:
    """A transcript flattened to one list of words and tokens."""

    words: list[str]
    starts: list[float]
    toks: list[Tok]

    def snippet(self, first: int, last: int, before: int = 0, after: int = 0) -> str:
        a = max(0, self.toks[first].wi - before)
        b = min(len(self.words), self.toks[last].wi + 1 + after)
        return " ".join(self.words[a:b])


def flatten(segments: list[dict]) -> Transcript:
    """Segments as stored in the database: [{start, end, text, words: [{w, start, end}]}]."""
    words: list[str] = []
    starts: list[float] = []
    toks: list[Tok] = []
    for seg in segments:
        for word in seg.get("words") or []:
            raw = str(word["w"]).strip()
            if not raw:
                continue
            wi = len(words)
            words.append(raw)
            starts.append(float(word["start"]))
            found = list(_TOKEN.finditer(raw))
            for n, m in enumerate(found):
                text = m.group(0)
                is_last = n == len(found) - 1
                if text[0].isdigit():
                    kind = "num" if text.isdigit() else "word"
                elif text in (":", "-", "–", "—"):
                    kind = "sep"
                else:
                    kind = "word"
                toks.append(
                    Tok(
                        text,
                        text.lower(),
                        kind,
                        float(word["start"]),
                        float(word["end"]),
                        is_last and raw[-1] in ".?!;",
                        is_last and raw[-1] in ".?!;,",
                        wi,
                    )  # fmt: skip
                )
    return Transcript(words, starts, toks)


@dataclass
class Candidate:
    id: str
    ref: Reference
    spoken_at: float
    first: int  # token index range, inclusive
    last: int
    relative: bool  # the book was understood from an earlier mention
    confidence: str  # "high", "medium" or "low"
    text: str  # the words as spoken


class _Reader:
    def __init__(self, toks: list[Tok]):
        self.t = toks
        self.n = len(toks)

    def word(self, i: int) -> str:
        return self.t[i].low if 0 <= i < self.n and self.t[i].kind == "word" else ""

    def is_sep(self, i: int, chars: set[str]) -> bool:
        return 0 <= i < self.n and self.t[i].kind == "sep" and self.t[i].low in chars

    def linked(self, i: int) -> bool:
        """Token i may continue a passage that started before it (no sentence end between)."""
        return 0 < i < self.n and not self.t[i - 1].stop

    # -- numbers ------------------------------------------------------------------------------

    def _below_hundred(self, k: int) -> tuple[int, int] | None:
        a = self.word(k)
        if a in TENS:
            value = TENS[a]
            if self.is_sep(k + 1, {"-"}) and self.word(k + 2) in UNITS:
                return value + UNITS[self.word(k + 2)], k + 3
            if self.word(k + 1) in UNITS and not self.t[k].pause:
                return value + UNITS[self.word(k + 1)], k + 2
            return value, k + 1
        if a in TEENS:
            return TEENS[a], k + 1
        if a in UNITS:
            return UNITS[a], k + 1
        return None

    def number(self, i: int) -> tuple[int, int] | None:
        """A number written in digits or spoken, and the index after it."""
        if not 0 <= i < self.n:
            return None
        if self.t[i].kind == "num":
            return int(self.t[i].text), i + 1
        first = self.word(i)
        if (first in UNITS or first == "a") and self.word(i + 1) == "hundred":
            total = (UNITS.get(first) or 1) * 100
            j = i + 2
            k = j + 1 if self.word(j) == "and" else j
            rest = self._below_hundred(k)
            if rest:
                return total + rest[0], rest[1]
            return total, j
        return self._below_hundred(i)

    def verse_range_end(self, k: int, start: int) -> tuple[int | None, int]:
        """After a first verse, an ending verse: "-19", "through 19", "and 3" (only the next verse)."""
        if k >= self.n or not self.linked(k):
            return None, k
        if self.is_sep(k, DASHES) or self.word(k) in RANGE_WORDS:
            m, only_next = k + 1, False
        elif self.word(k) == "and":
            m, only_next = k + 1, True
        else:
            return None, k
        if self.word(m) in VERSE_WORDS:
            m += 1
        num = self.number(m)
        if num and num[0] > start and (not only_next or num[0] == start + 1):
            return num[0], num[1]
        return None, k


def _match_book(r: _Reader, i: int) -> tuple[Book, int] | None:
    """The longest book name starting at token i, in speech: names only, no abbreviations."""
    first = r.t[i]
    if first.kind == "sep" or first.low in ("i", "ii", "iii"):
        return None  # "I" is the pronoun; Whisper writes "First John" or "1 John"
    for length in (4, 3, 2, 1):
        if i + length > r.n:
            continue
        window = r.t[i : i + length]
        if any(t.kind == "sep" for t in window) or any(t.stop for t in window[:-1]):
            continue
        if any(t.kind == "num" for t in window[1:]):
            continue
        book = resolve_book(" ".join(t.low for t in window), abbreviations=False)
        if book:
            return book, i + length
    return None


@dataclass
class _Parsed:
    chapter: int
    verse_start: int | None
    verse_end: int | None
    end: int  # index after the last token used
    keyword: bool  # the word "chapter" or "verse" was said
    numbered: bool  # a ":" or "verse" introduced the verses


def _verses_after(r: _Reader, k: int, allow_bare: bool) -> tuple[int, int | None, int, bool] | None:
    """Verses after a chapter number: ":17", " verse 17", " and verse 17" or, if allowed, " 17"."""
    if not r.linked(k):
        return None
    if r.is_sep(k, {":"}):
        num = r.number(k + 1)
    else:
        m = k
        if r.word(m) in ("and", "at") and r.word(m + 1) in VERSE_WORDS:
            m += 1
        if r.word(m) in VERSE_WORDS:
            num = r.number(m + 1)
        elif allow_bare and not r.t[k - 1].pause:
            num = r.number(k)
        else:
            return None
    if not num:
        return None
    end, after = r.verse_range_end(num[1], num[0])
    return num[0], end, (after if end is not None else num[1]), True


def _parse_after_book(r: _Reader, book: Book, j: int) -> _Parsed | None:
    if not r.linked(j):
        return None
    k, keyword = j, False
    if r.word(k) in ("chapter", "chapters"):
        keyword, k = True, k + 1
    if len(book.chapters) == 1 and not keyword:
        # Jude 3, Jude verse 3, Jude verses 3 through 5.
        if r.word(k) in VERSE_WORDS:
            keyword, k = True, k + 1
        num = r.number(k)
        if not num:
            return None
        end, after = r.verse_range_end(num[1], num[0])
        return _Parsed(1, num[0], end, after if end is not None else num[1], keyword, keyword)
    num = r.number(k)
    if not num:
        return None
    chapter, k = num
    verses = _verses_after(r, k, allow_bare=not keyword)
    if verses is None:
        return _Parsed(chapter, None, None, k, keyword, False)
    return _Parsed(chapter, verses[0], verses[1], verses[2], keyword, True)


def _parse_relative(r: _Reader, i: int, book: str, chapter: int) -> _Parsed | None:
    """ "verse 5", "verses 3 through 5" after a passage, or "chapter 4 verse 2"."""
    word = r.word(i)
    if word in VERSE_WORDS:
        num = r.number(i + 1)
        if not num:
            return None
        end, after = r.verse_range_end(num[1], num[0])
        return _Parsed(chapter, num[0], end, after if end is not None else num[1], True, True)
    if word == "chapter":
        num = r.number(i + 1)
        if not num:
            return None
        verses = _verses_after(r, num[1], allow_bare=False)
        if verses is None:
            return None  # "in chapter 4" alone is too vague to count
        return _Parsed(num[0], verses[0], verses[1], verses[2], True, True)
    return None


def _validated(book: str, p: _Parsed) -> Reference | None:
    ref = try_validate(book, p.chapter, p.verse_start, p.verse_end)
    if ref is None and p.verse_end is not None:
        ref = try_validate(book, p.chapter, p.verse_start, None)
    # A verse that isn't in the chapter still leaves the chapter, but not in a one-chapter book,
    # where the number was the verse and there is no chapter to fall back to.
    named = find_book(book)
    if ref is None and p.verse_start is not None and named and len(named.chapters) > 1:
        ref = try_validate(book, p.chapter, None, None)
    return ref


def find_references(transcript: Transcript) -> list[Candidate]:
    """Every passage that looks named aloud, in the order spoken, with the time of the first word."""
    r = _Reader(transcript.toks)
    found: list[Candidate] = []
    last: tuple[str, int, float] | None = None  # book, chapter, when
    i = 0
    while i < r.n:
        tok = r.t[i]
        match = _match_book(r, i)
        if match:
            book, name_end = match
            parsed = _parse_after_book(r, book, name_end)
            if parsed is not None:
                ambiguous = book.name in AMBIGUOUS_BOOKS
                capitalised = tok.text[:1].isupper() or tok.kind == "num"
                vague = parsed.verse_start is None and not parsed.keyword
                if ambiguous and vague and r.t[name_end].kind == "word":
                    i += 1  # "Job six months ago": a spoken number after a common word is not a chapter
                    continue
                ref = _validated(book.name, parsed)
                if ref is not None and not (ambiguous and not capitalised):
                    confidence = "low" if ambiguous and vague else "medium" if vague else "high"
                    if ref.verse_start is None and parsed.verse_start is not None:
                        confidence = "medium"  # the verse was not in the passage; kept the chapter
                    found.append(
                        Candidate(
                            f"c{len(found) + 1}",
                            ref,
                            tok.start,
                            i,
                            parsed.end - 1,
                            False,
                            confidence,
                            transcript.snippet(i, parsed.end - 1).rstrip(".,;:!?"),
                        )  # fmt: skip
                    )
                    last = (ref.book, ref.chapter, tok.start)
                    i = parsed.end
                    continue
        elif last and tok.kind == "word" and tok.low in ("verse", "verses", "chapter"):
            if tok.start - last[2] <= RELATIVE_WINDOW_SEC:
                parsed = _parse_relative(r, i, last[0], last[1])
                ref = parsed and _validated(last[0], parsed)
                if parsed is not None and ref is not None and ref.verse_start is not None:
                    found.append(
                        Candidate(
                            f"c{len(found) + 1}",
                            ref,
                            tok.start,
                            i,
                            parsed.end - 1,
                            True,
                            "medium",
                            transcript.snippet(i, parsed.end - 1).rstrip(".,;:!?"),
                        )  # fmt: skip
                    )
                    last = (ref.book, ref.chapter, tok.start)
                    i = parsed.end
                    continue
        i += 1
    return found
