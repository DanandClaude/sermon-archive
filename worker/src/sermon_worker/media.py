"""ffmpeg and ffprobe helpers, and waveform peaks."""

from __future__ import annotations

import json
import subprocess
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class MediaError(Exception):
    """ffmpeg or ffprobe failed. The message includes the tail of its output."""


@dataclass(frozen=True)
class Probe:
    duration: float
    sample_rate: int
    channels: int
    codec: str


def probe(path: Path) -> Probe:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "format=duration:stream=sample_rate,channels,codec_name",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True,
    )  # fmt: skip
    if result.returncode != 0:
        raise MediaError(f"Could not read the audio file: {result.stderr.strip()[-500:]}")
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise MediaError("The file has no audio track.")
    duration = float(data.get("format", {}).get("duration") or 0)
    if duration <= 0:
        raise MediaError("The audio has no length.")
    stream = streams[0]
    return Probe(
        duration=duration,
        sample_rate=int(stream.get("sample_rate") or 0),
        channels=int(stream.get("channels") or 0),
        codec=stream.get("codec_name", ""),
    )


def run_ffmpeg(
    args: list[str],
    duration: float,
    on_progress: Callable[[float], None] | None = None,
) -> str:
    """Runs ffmpeg and returns its stderr. Reports 0-1 progress from ffmpeg's -progress output."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
    )
    stderr_tail: deque[str] = deque(maxlen=200)

    # stderr is drained on a thread so a chatty filter can never fill the pipe and stall ffmpeg.
    import threading

    def drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line)

    thread = threading.Thread(target=drain, daemon=True)
    thread.start()
    assert proc.stdout is not None
    for line in proc.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_us" and on_progress and duration > 0:
            try:
                on_progress(max(0.0, min(1.0, int(value) / 1_000_000 / duration)))
            except ValueError:
                pass
    code = proc.wait()
    thread.join(timeout=5)
    text = "".join(stderr_tail)
    if code != 0:
        raise MediaError(f"ffmpeg failed (exit {code}): {text.strip()[-800:]}")
    return text


def compute_peaks(path: Path, buckets_per_second: float = 2.0, max_buckets: int = 6000) -> dict:
    """Coarse waveform for the UI: the loudest sample in each slice, as 0-1. Small enough to fetch."""
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path),
            "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-",
        ],
        capture_output=True,
    )  # fmt: skip
    if proc.returncode != 0:
        raise MediaError(f"Could not decode audio for peaks: {proc.stderr.decode()[-500:]}")
    samples = np.frombuffer(proc.stdout, dtype="<i2")
    if samples.size == 0:
        raise MediaError("The audio decoded to nothing.")
    duration = samples.size / 8000
    buckets = int(max(1, min(max_buckets, round(duration * buckets_per_second))))
    edges = np.linspace(0, samples.size, buckets + 1).astype(int)
    peaks = [
        float(np.abs(samples[a:b]).max()) / 32768 if b > a else 0.0
        for a, b in zip(edges[:-1], edges[1:], strict=True)
    ]
    return {
        "version": 1,
        "duration": round(duration, 3),
        "bucketSeconds": round(duration / buckets, 4),
        "peaks": [round(p, 3) for p in peaks],
    }
