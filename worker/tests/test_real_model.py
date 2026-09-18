"""Runs the real Whisper model. Skipped unless a model is available and macOS `say` can make speech.

    WHISPER_TEST_MODEL=medium worker/run.sh -m pytest tests/test_real_model.py

Uses a model already on this machine; it never downloads one.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from sermon_worker.transcribe import FasterWhisperTranscriber, build_prompt

MODEL = os.environ.get("WHISPER_TEST_MODEL")
pytestmark = [
    pytest.mark.real_model,
    pytest.mark.skipif(not MODEL, reason="set WHISPER_TEST_MODEL to run against a real model"),
    pytest.mark.skipif(shutil.which("say") is None, reason="needs macOS `say` to make speech"),
]

TEXT = (
    "Turn with me to Hebrews chapter thirteen, verse seventeen. Obey them that have the rule "
    "over you, and submit yourselves, for they watch for your souls. Peter says the same thing "
    "in First Peter, chapter five, verses two and three."
)


@pytest.fixture(scope="module")
def speech(tmp_path_factory):
    directory = tmp_path_factory.mktemp("speech")
    aiff, wav = directory / "s.aiff", directory / "s.wav"
    subprocess.run(["say", "-o", str(aiff), TEXT], check=True)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", "44100", str(wav)],
        check=True,
    )  # fmt: skip
    return wav


def test_transcribes_speech_with_word_timings_and_the_scripture_vocabulary(speech):
    os.environ["HF_HUB_OFFLINE"] = "1"  # never download
    transcriber = FasterWhisperTranscriber(MODEL, model_path=None if "/" not in MODEL else MODEL)
    seen: list[float] = []
    result = transcriber.transcribe(
        speech, prompt=build_prompt("Pastor Lee"), on_progress=seen.append
    )

    text = result.full_text.lower()
    assert "hebrews" in text and "obey them that have the rule over you" in text
    words = [w for s in result.segments for w in s.words]
    assert len(words) > 30
    assert all(a.start <= b.start for a, b in zip(words, words[1:], strict=False))
    assert all(0 <= w.prob <= 1 for w in words)
    assert seen == sorted(seen) and seen[-1] <= 0.99
    assert result.model.startswith("faster-whisper:")
