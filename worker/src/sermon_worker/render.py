"""Plain text and SRT subtitles from word-timed segments.

A port of src/lib/transcripts/render.ts, so the files the worker files are the ones the app
offers to download. shared/transcript-cases.json is rendered by both and must match exactly.
"""

from __future__ import annotations

import re

MAX_LINE = 42
MAX_CUE_CHARS = MAX_LINE * 2
MAX_CUE_SECONDS = 6.0
MIN_CUE_SECONDS = 0.3

_ENDS_SENTENCE = re.compile(r"[.?!][\"')\]]*$")


def _js_round(value: float) -> int:
    """JavaScript's Math.round: halves round up, where Python's round() goes to even."""
    import math

    return math.floor(value + 0.5)


def format_timestamp(seconds: float, separator: str = ",") -> str:
    total = max(0, _js_round(seconds * 1000))
    ms = total % 1000
    s = (total // 1000) % 60
    m = (total // 60000) % 60
    h = total // 3600000
    return f"{h:02d}:{m:02d}:{s:02d}{separator}{ms:03d}"


def wrap_lines(text: str) -> str:
    lines: list[str] = []
    line = ""
    for word in text.split():
        if line and len(line) + 1 + len(word) > MAX_LINE:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    if line:
        lines.append(line)
    return "\n".join(lines)


def _cues_from_words(words: list[dict]) -> list[dict]:
    cues: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if not current:
            return
        cues.append(
            {
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "text": " ".join(w["w"] for w in current),
            }
        )
        current.clear()

    for word in words:
        if current:
            chars = len(" ".join(w["w"] for w in current)) + 1 + len(word["w"])
            too_long = chars > MAX_CUE_CHARS or word["end"] - current[0]["start"] > MAX_CUE_SECONDS
            sentence_break = bool(_ENDS_SENTENCE.search(current[-1]["w"])) and chars > MAX_LINE / 2
            if too_long or sentence_break:
                flush()
        current.append(word)
    flush()
    return cues


def build_cues(segments: list[dict]) -> list[dict]:
    cues: list[dict] = []
    for segment in segments:
        text = segment["text"].strip()
        if not text:
            continue
        if segment.get("words"):
            cues.extend(_cues_from_words(segment["words"]))
        else:
            pieces = text.split()
            step = (segment["end"] - segment["start"]) / len(pieces)
            cues.extend(
                _cues_from_words(
                    [
                        {
                            "w": w,
                            "start": segment["start"] + i * step,
                            "end": segment["start"] + (i + 1) * step,
                        }
                        for i, w in enumerate(pieces)
                    ]
                )
            )
    out: list[dict] = []
    for i, cue in enumerate(cues):
        nxt = cues[i + 1] if i + 1 < len(cues) else None
        end = max(cue["end"], cue["start"] + MIN_CUE_SECONDS)
        if nxt and end > nxt["start"] and nxt["start"] > cue["start"]:
            end = nxt["start"]
        out.append({**cue, "end": end})
    return out


def to_srt(segments: list[dict]) -> str:
    return "\n".join(
        f"{i + 1}\n{format_timestamp(c['start'])} --> {format_timestamp(c['end'])}\n"
        f"{wrap_lines(c['text'])}\n"
        for i, c in enumerate(build_cues(segments))
    )


def to_text(segments: list[dict], pause_seconds: float = 1.5) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    previous_end: float | None = None
    for segment in segments:
        text = segment["text"].strip()
        if not text:
            continue
        if (
            previous_end is not None
            and segment["start"] - previous_end >= pause_seconds
            and current
        ):
            paragraphs.append(" ".join(current))
            current = []
        current.append(text)
        previous_end = segment["end"]
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(paragraphs) + ("\n" if paragraphs else "")
