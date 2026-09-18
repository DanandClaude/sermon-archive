"""Transcription: faster-whisper (in-house), plus a scripted stand-in for development and tests."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .config import Config
from .media import probe
from .pipeline import bible_books


@dataclass
class Word:
    w: str
    start: float
    end: float
    prob: float


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class TranscriptResult:
    segments: list[Segment]
    language: str
    model: str
    duration: float

    @property
    def full_text(self) -> str:
        return " ".join(s.text.strip() for s in self.segments if s.text.strip())

    def low_confidence(self, threshold: float) -> list[list[int]]:
        """[segment index, word index] pairs for words the model was unsure of."""
        return [
            [i, j]
            for i, seg in enumerate(self.segments)
            for j, word in enumerate(seg.words)
            if word.prob < threshold
        ]

    def segments_json(self) -> list[dict]:
        """The shape stored in the database. Times are rounded to keep the record small."""
        return [
            {
                "start": round(s.start, 2),
                "end": round(s.end, 2),
                "text": s.text.strip(),
                "words": [
                    {
                        "w": w.w.strip(),
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                        "prob": round(w.prob, 3),
                    }
                    for w in s.words
                ],
            }
            for s in self.segments
        ]


class Transcriber(Protocol):
    name: str

    def transcribe(
        self, audio: Path, *, prompt: str, on_progress: Callable[[float], None]
    ) -> TranscriptResult: ...


def build_prompt(speaker: str | None) -> str:
    """Primes the model with scripture vocabulary and the speaker's name.

    Whisper keeps only the last ~224 tokens of a prompt, so the speaker goes last.
    """
    books = ", ".join(bible_books())
    prompt = f"Books of the Bible: {books}."
    if speaker and speaker.strip():
        prompt += f" A sermon by {speaker.strip()}."
    return prompt


class ModelNotAvailable(Exception):
    """The Whisper model is not on this machine and downloading was not allowed."""


class FasterWhisperTranscriber:
    """Runs faster-whisper (CTranslate2). Long audio is handled by the library itself."""

    def __init__(
        self,
        model: str,
        model_path: str | None = None,
        device: str = "cpu",
        compute_type: str = "int8",
        cpu_threads: int = 0,
        allow_download: bool = False,
    ):
        self.model_name = model
        self.model_path = model_path
        self.device = device
        self.compute_type = compute_type
        self.cpu_threads = cpu_threads
        self.allow_download = allow_download
        self._model = None
        self.name = f"faster-whisper:{model}:{compute_type}"

    def _load(self):
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel

        source = self.model_path or self.model_name
        try:
            self._model = WhisperModel(
                source,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=self.cpu_threads,
                local_files_only=not self.allow_download and not self.model_path,
            )
        except Exception as error:
            if self.model_path or self.allow_download:
                raise
            raise ModelNotAvailable(
                f"The Whisper model {self.model_name!r} is not on this machine. Download it with "
                f"`python -m sermon_worker.fetch_model {self.model_name}` or set WHISPER_MODEL_PATH."
            ) from error
        return self._model

    def transcribe(
        self, audio: Path, *, prompt: str, on_progress: Callable[[float], None]
    ) -> TranscriptResult:
        model = self._load()
        segments_iter, info = model.transcribe(
            str(audio),
            language="en",
            beam_size=5,
            word_timestamps=True,
            initial_prompt=prompt,
            # Hiss and silence are where Whisper invents text or loops, so guard against it.
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            hallucination_silence_threshold=2.0,
        )
        duration = float(getattr(info, "duration", 0) or 0)
        segments: list[Segment] = []
        for seg in segments_iter:
            segments.append(
                Segment(
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text,
                    words=[
                        Word(w.word, float(w.start), float(w.end), float(w.probability))
                        for w in (seg.words or [])
                    ],
                )
            )
            if duration > 0:
                on_progress(min(0.99, float(seg.end) / duration))
        return TranscriptResult(segments, language="en", model=self.name, duration=duration)


_CANNED = [
    "Turn with me to Hebrews chapter thirteen, verse seventeen.",
    "Obey them that have the rule over you, and submit yourselves, for they watch for your souls.",
    "Back in verse seven of this same chapter, the writer says to remember them which have the rule over you.",
    "Peter says the same thing in First Peter, chapter five, verses two and three.",
    "Somebody is losing sleep over you, and that is a gift.",
]


class FakeTranscriber:
    """Canned text spread across the audio, with a few doubtful words. For trying the pipeline
    without a model. It is refused in production."""

    name = "fake:scripted"

    def transcribe(
        self, audio: Path, *, prompt: str, on_progress: Callable[[float], None]
    ) -> TranscriptResult:
        duration = probe(audio).duration
        span = 6.0
        segments: list[Segment] = []
        t, index = 0.0, 0
        while t < duration:
            end = min(duration, t + span)
            words_text = _CANNED[index % len(_CANNED)].split()
            step = (end - t) / len(words_text)
            words = [
                Word(w, t + k * step, t + (k + 1) * step, 0.3 if k == 3 else 0.95)
                for k, w in enumerate(words_text)
            ]
            segments.append(Segment(t, end, " ".join(words_text), words))
            on_progress(min(0.99, end / duration))
            t, index = end, index + 1
        return TranscriptResult(segments, "en", self.name, duration)


def make_transcriber(config: Config) -> Transcriber:
    if config.transcriber == "fake":
        return FakeTranscriber()
    return FasterWhisperTranscriber(
        model=config.whisper_model,
        model_path=config.whisper_model_path,
        device=config.whisper_device,
        compute_type=config.whisper_compute_type,
        cpu_threads=config.whisper_cpu_threads,
        allow_download=config.allow_model_download,
    )
