"""The books of the Bible and how a passage is written, validated and named.

This mirrors src/lib/scripture/canon.ts. Both read the same shared/canon.json (chapter and verse
counts derived from the public-domain King James Bible) and shared/book-aliases.json, and both
are tested against shared/reference-cases.json, so the app and the worker agree on what a
valid passage is.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache

from .pipeline import shared_dir


@dataclass(frozen=True)
class Book:
    name: str
    testament: str  # "Old" or "New"
    genre: str
    chapters: tuple[int, ...]  # verses in each chapter; chapters[0] is chapter 1

    @property
    def index(self) -> int:
        return book_names().index(self.name)


@dataclass(frozen=True)
class Reference:
    """A passage. No verses means the whole chapter."""

    book: str
    chapter: int
    verse_start: int | None = None
    verse_end: int | None = None

    def as_json(self) -> dict:
        return {
            "book": self.book,
            "chapter": self.chapter,
            "verseStart": self.verse_start,
            "verseEnd": self.verse_end,
        }

    @staticmethod
    def from_json(value: dict | None) -> Reference | None:
        if not value or not isinstance(value.get("book"), str):
            return None
        chapter = value.get("chapter")
        if not isinstance(chapter, int):
            return None
        return Reference(value["book"], chapter, value.get("verseStart"), value.get("verseEnd"))


@lru_cache(maxsize=1)
def _load() -> tuple[tuple[Book, ...], dict[str, Book], dict[str, Book]]:
    canon = json.loads((shared_dir() / "canon.json").read_text())
    aliases = json.loads((shared_dir() / "book-aliases.json").read_text())["books"]
    books = tuple(
        Book(b["name"], b["testament"], b["genre"], tuple(b["chapters"])) for b in canon["books"]
    )
    spellings: dict[str, Book] = {}
    abbreviations: dict[str, Book] = {}
    for book in books:
        spellings[book.name.lower()] = book
        for alt in aliases[book.name]["alternates"]:
            spellings[alt] = book
        for abbr in aliases[book.name]["abbreviations"]:
            abbreviations[abbr] = book
    return books, spellings, abbreviations


def canon() -> tuple[Book, ...]:
    return _load()[0]


@lru_cache(maxsize=1)
def book_names() -> list[str]:
    return [b.name for b in canon()]


def find_book(name: str) -> Book | None:
    wanted = name.strip().lower()
    return next((b for b in canon() if b.name.lower() == wanted), None)


_ORDINALS = [
    (re.compile(r"^(first|1st|i)\s+"), "1 "),
    (re.compile(r"^(second|2nd|ii)\s+"), "2 "),
    (re.compile(r"^(third|3rd|iii)\s+"), "3 "),
    (re.compile(r"^([123])(?=[a-z])"), r"\1 "),
]


def normalize_book_text(text: str) -> str:
    """Lower-cases, drops periods, tidies spaces, and turns First, 1st, I and 1Peter into "1 ..."."""
    out = re.sub(r"\s+", " ", text.lower().replace(".", "")).strip()
    for pattern, replacement in _ORDINALS:
        if pattern.search(out):
            return pattern.sub(replacement, out, count=1)
    return out


def resolve_book(text: str, abbreviations: bool = True) -> Book | None:
    """A book from how it was written or said. Abbreviations are for typed text only: in speech,
    a bare "is" or "ex" is an ordinary word."""
    _, spellings, abbrs = _load()
    key = normalize_book_text(text)
    return spellings.get(key) or (abbrs.get(key) if abbreviations else None)


def spoken_book_names() -> dict[str, Book]:
    """Every full spelling that is safe to look for in speech, normalised."""
    return dict(_load()[1])


class Invalid(Exception):
    """A passage that is not in the Bible. The message is fit to show to a person."""


def validate_reference(
    book: str, chapter: int, verse_start: int | None = None, verse_end: int | None = None
) -> Reference:
    found = resolve_book(book)
    if found is None:
        raise Invalid(f"“{book}” isn’t a book of the Bible.")
    count = len(found.chapters)
    if chapter < 1 or chapter > count:
        raise Invalid(f"{found.name} has {count} chapter{'' if count == 1 else 's'}.")
    verses = found.chapters[chapter - 1]
    if verse_start is None:
        if verse_end is not None:
            raise Invalid("Give a starting verse as well as an ending verse.")
        return Reference(found.name, chapter)
    if verse_start < 1 or verse_start > verses:
        raise Invalid(f"{found.name} {chapter} has {verses} verse{'' if verses == 1 else 's'}.")
    if verse_end is not None and (verse_end < verse_start or verse_end > verses):
        if verse_end < verse_start:
            raise Invalid("The ending verse can’t come before the starting verse.")
        raise Invalid(f"{found.name} {chapter} has {verses} verses.")
    return Reference(
        found.name, chapter, verse_start, None if verse_end == verse_start else verse_end
    )


def try_validate(
    book: str, chapter: int, verse_start: int | None = None, verse_end: int | None = None
) -> Reference | None:
    try:
        return validate_reference(book, chapter, verse_start, verse_end)
    except Invalid:
        return None


def format_reference(ref: Reference) -> str:
    """Romans 8:28–39, 1 Peter 5:2–3, Hebrews 13:17, Psalm 23."""
    name = "Psalm" if ref.book == "Psalms" else ref.book
    if ref.verse_start is None:
        return f"{name} {ref.chapter}"
    verses = str(ref.verse_start) if ref.verse_end is None else f"{ref.verse_start}–{ref.verse_end}"
    return f"{name} {ref.chapter}:{verses}"


_RANGE = r"(?:-|–|—|to|through|thru)"
_REFERENCE_TEXT = re.compile(
    rf"^(.+?)\s+(\d+)(?:\s*[:.]\s*(\d+)(?:\s*{_RANGE}\s*(\d+))?)?$", re.IGNORECASE
)
_ONE_CHAPTER_RANGE = re.compile(rf"^(.+?)\s+(\d+)\s*{_RANGE}\s*(\d+)$", re.IGNORECASE)
_WRITE_LIKE = "Write it like “Hebrews 13:17” or “Psalm 23”."


def parse_reference_text(text: str) -> Reference:
    """Reads a typed passage such as a tape label: Hebrews 13:17, Romans 8:28-39, Psalm 23.
    For a one-chapter book, "Jude 3" means verse 3. Raises Invalid."""
    trimmed = text.strip()
    bare = _ONE_CHAPTER_RANGE.match(trimmed)
    if bare:
        book = resolve_book(bare.group(1))
        if book and len(book.chapters) == 1:
            return validate_reference(book.name, 1, int(bare.group(2)), int(bare.group(3)))
    match = _REFERENCE_TEXT.match(trimmed)
    if not match:
        raise Invalid(_WRITE_LIKE)
    book = resolve_book(match.group(1))
    if book is None:
        raise Invalid(f"“{match.group(1).strip()}” isn’t a book of the Bible.")
    first = int(match.group(2))
    if match.group(3) is None and len(book.chapters) == 1:
        return validate_reference(book.name, 1, first)
    return validate_reference(
        book.name,
        first,
        None if match.group(3) is None else int(match.group(3)),
        None if match.group(4) is None else int(match.group(4)),
    )


def tags_for_book(book_name: str) -> list[tuple[str, str]]:
    """The (kind, name) testament, genre and book tags a passage brings with it."""
    book = find_book(book_name)
    if book is None:
        return []
    return [
        ("testament", f"{book.testament} Testament"),
        ("genre", book.genre),
        ("book", book.name),
    ]
