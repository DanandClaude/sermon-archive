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


def _split_segment(seg: Segment, target: float, min_break: float) -> list[Segment]:
    pieces: list[Segment] = []
    group: list[Word] = []
    for word in seg.words:
        group.append(word)
        age = word.end - group[0].start
        ends_sentence = word.w.strip().endswith((".", "?", "!"))
        if (ends_sentence and age >= min_break) or age >= target:
            pieces.append(_piece(group))
            group = []
    if group:
        pieces.append(_piece(group))
    return pieces


def _piece(words: list[Word]) -> Segment:
    return Segment(words[0].start, words[-1].end, " ".join(w.w.strip() for w in words), list(words))


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

    def resegmented(self, target: float = 15.0, min_break: float = 4.0) -> TranscriptResult:
        """Splits long segments at sentence ends so every timestamp lands somewhere useful.

        Whisper works in 30-second windows and can return a segment that long. A segment over
        `target` seconds is cut after a sentence-ending word once it is at least `min_break`
        seconds old, and forced to cut at `target` if a sentence runs on. Words are never
        reordered or dropped.
        """
        out: list[Segment] = []
        for seg in self.segments:
            if not seg.words or seg.end - seg.start <= target:
                out.append(seg)
            else:
                out.extend(_split_segment(seg, target, min_break))
        return TranscriptResult(out, self.language, self.model, self.duration)

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


class MlxWhisperTranscriber:
    """Runs Whisper on an Apple Silicon Mac's GPU through MLX. Measured about 4x faster than the
    CPU engine on a real tape, and its large-v3-turbo model was also more accurate. macOS only.

    The model is looked up in the local Hugging Face cache and never downloaded unless allowed.
    """

    DEFAULT_REPO = "mlx-community/whisper-large-v3-turbo"

    def __init__(
        self,
        repo: str = DEFAULT_REPO,
        model_path: str | None = None,
        allow_download: bool = False,
    ):
        self.repo = repo
        self.model_path = model_path
        self.allow_download = allow_download
        self.name = f"mlx-whisper:{repo.rsplit('/', 1)[-1]}"

    def _resolve(self) -> str:
        if self.model_path:
            return self.model_path
        from huggingface_hub import snapshot_download

        try:
            return snapshot_download(self.repo, local_files_only=not self.allow_download)
        except Exception as error:
            if self.allow_download:
                raise
            raise ModelNotAvailable(
                f"The MLX model {self.repo!r} is not on this machine. Download it with "
                f"`python -m sermon_worker.fetch_model {self.repo}` or set MLX_MODEL to a folder."
            ) from error

    def transcribe(
        self, audio: Path, *, prompt: str, on_progress: Callable[[float], None]
    ) -> TranscriptResult:
        try:
            import mlx_whisper
        except ImportError as error:
            raise ModelNotAvailable(
                "MLX transcription needs an Apple Silicon Mac and the mlx extra: "
                'pip install -e "worker[mlx]"'
            ) from error
        model = self._resolve()
        on_progress(0.02)  # MLX reports no progress while it works; the stage jumps to the end
        result = mlx_whisper.transcribe(
            str(audio),
            path_or_hf_repo=model,
            language="en",
            word_timestamps=True,
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
            hallucination_silence_threshold=2.0,
            verbose=None,
        )
        segments = [
            Segment(
                start=float(seg["start"]),
                end=float(seg["end"]),
                text=seg["text"],
                words=[
                    Word(
                        w["word"],
                        float(w["start"]),
                        float(w["end"]),
                        float(w.get("probability", 1.0)),
                    )
                    for w in seg.get("words", [])
                ],
            )
            for seg in result.get("segments", [])
        ]
        duration = segments[-1].end if segments else 0.0
        on_progress(0.99)
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
    if config.transcriber == "mlx":
        return MlxWhisperTranscriber(
            repo=config.mlx_model,
            model_path=config.whisper_model_path,
            allow_download=config.allow_model_download,
        )
    return FasterWhisperTranscriber(
        model=config.whisper_model,
        model_path=config.whisper_model_path,
        device=config.whisper_device,
        compute_type=config.whisper_compute_type,
        cpu_threads=config.whisper_cpu_threads,
        allow_download=config.allow_model_download,
    )
