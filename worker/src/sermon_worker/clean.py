"""The audio cleanup chain (SPEC section 4.1).

Suggested chain, tuned on real tapes: high-pass, hum notches, FFT denoise, click removal, then
loudness normalisation to about -16 LUFS. Loudness is measured in a first pass and applied in a
second so the result lands on target. Tape wobble and flutter are not corrected.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .media import MediaError, probe, run_ffmpeg

# A narrow spike this many dB above its neighbours in the average spectrum counts as hum.
HUM_SPIKE_DB = 10.0


@dataclass(frozen=True)
class CleanConfig:
    # Repair clipped peaks. Placed first: filtering a clipped signal spreads the distortion.
    declip: bool = False
    highpass_hz: float = 70.0
    # Mains hum and its harmonics. None (the default) means "look for it first": notches are added
    # only if hum is actually present, because a notch at 120 or 180 Hz also cuts into a male voice.
    # Give a tuple such as (60.0, 120.0, 180.0) to force specific notches, or () for none.
    hum_hz: tuple[float, ...] | None = None
    # Notch sharpness. Lower is wider. Tape speed drift makes hum wander, so a very narrow notch
    # (40) can miss it; this middle value is a starting point to tune on real tapes.
    hum_q: float = 20.0
    # Off by default: on real tapes, denoising did not help transcription and slightly hurt it.
    denoise: bool = False
    denoise_reduction_db: float = 12.0
    denoise_floor_db: float = -40.0
    declick: bool = False
    target_lufs: float = -16.0
    true_peak_db: float = -1.5
    loudness_range: float = 11.0
    mp3_bitrate: str = "192k"
    sample_rate: int = 44100
    channels: int = 1
    extra_filters: tuple[str, ...] = field(default_factory=tuple)


HUM_FRAME = 8192  # about one second at 8 kHz, so hum shows as a sharp spike ~1 Hz wide


def detect_hum(path: Path, max_seconds: float = 180.0) -> tuple[float, ...]:
    """Returns the mains-hum frequencies to notch (for example (60.0, 120.0, 180.0)), or () if none.

    Hum is a very narrow, steady spike at 50 or 60 Hz and its multiples. Voices are broad, so a
    spike far above its own neighbours in the average spectrum is hum, not speech.
    """
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-t", str(max_seconds), "-i", str(path),
         "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
        capture_output=True,
    )  # fmt: skip
    samples = np.frombuffer(proc.stdout, dtype="<f4")
    if proc.returncode != 0 or samples.size < HUM_FRAME * 2:
        return ()
    window = np.hanning(HUM_FRAME)
    frames = samples[: samples.size // HUM_FRAME * HUM_FRAME].reshape(-1, HUM_FRAME)
    power = (np.abs(np.fft.rfft(frames * window)) ** 2).mean(axis=0)
    freqs = np.fft.rfftfreq(HUM_FRAME, 1 / 8000)

    def spike_db(hz: float) -> float:
        peak = power[(freqs >= hz - 1.5) & (freqs <= hz + 1.5)].max()
        around = power[
            ((freqs >= hz - 12) & (freqs <= hz - 4)) | ((freqs >= hz + 4) & (freqs <= hz + 12))
        ]
        return float(10 * np.log10(max(peak, 1e-20) / max(np.median(around), 1e-20)))

    best: tuple[float, ...] = ()
    best_score = 0.0
    for mains in (50.0, 60.0):
        spikes = [spike_db(mains * k) for k in (1, 2, 3)]
        strong = [k + 1 for k, db in enumerate(spikes) if db >= HUM_SPIKE_DB]
        # Hum shows up strongly at the fundamental, or at several harmonics together.
        if (1 in strong) or len(strong) >= 2:
            score = max(spikes)
            if score > best_score:
                best, best_score = (
                    tuple(mains * (k + 1) for k, db in enumerate(spikes) if db >= HUM_SPIKE_DB - 4),
                    score,
                )
    return best


def build_filters(cfg: CleanConfig, hum: tuple[float, ...] | None = None) -> list[str]:
    """The filters before loudness normalisation, in order."""
    filters = ["adeclip"] if cfg.declip else []
    filters.append(f"highpass=f={cfg.highpass_hz:g}")
    # `hum` is what detect_hum found; a fixed cfg.hum_hz overrides it.
    notches = cfg.hum_hz if cfg.hum_hz is not None else (hum or ())
    for hz in notches:
        filters.append(f"bandreject=f={hz:g}:width_type=q:w={cfg.hum_q:g}")
    if cfg.denoise:
        filters.append(f"afftdn=nr={cfg.denoise_reduction_db:g}:nf={cfg.denoise_floor_db:g}:tn=1")
    if cfg.declick:
        filters.append("adeclick")
    filters.extend(cfg.extra_filters)
    return filters


def _loudnorm(cfg: CleanConfig, measured: dict | None) -> str:
    base = f"loudnorm=I={cfg.target_lufs:g}:TP={cfg.true_peak_db:g}:LRA={cfg.loudness_range:g}"
    if measured is None:
        return base + ":print_format=json"
    return (
        f"{base}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )


def parse_loudnorm(stderr: str) -> dict | None:
    """Pulls loudnorm's measurement JSON out of ffmpeg's output. None if there was nothing to measure."""
    blocks = re.findall(r"\{[^{}]*\}", stderr, re.S)
    for block in reversed(blocks):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if "input_i" not in data:
            continue
        try:
            values = {
                k: float(data[k])
                for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
            }
        except (KeyError, ValueError):
            return None
        # Silence measures as -inf; there is nothing to normalise.
        return data if all(math.isfinite(v) for v in values.values()) else None
    return None


def clean_audio(
    src: Path,
    dest: Path,
    cfg: CleanConfig | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> dict:
    """Writes a cleaned MP3 to `dest` and returns facts about it. The source is only read."""
    cfg = cfg or CleanConfig()
    info = probe(src)
    hum = detect_hum(src) if cfg.hum_hz is None else ()
    chain = ",".join(build_filters(cfg, hum))

    # Pass 1: run the same chain and measure loudness. Progress 0 to 0.35.
    measure_stderr = run_ffmpeg(
        [
            "-i",
            str(src),
            "-map",
            "0:a:0",
            "-af",
            f"{chain},{_loudnorm(cfg, None)}",
            "-f",
            "null",
            "-",
        ],
        info.duration,
        (lambda p: on_progress(p * 0.35)) if on_progress else None,
    )
    measured = parse_loudnorm(measure_stderr)

    # Pass 2: apply the measured values and encode. Progress 0.35 to 1.
    final_chain = f"{chain},{_loudnorm(cfg, measured)}" if measured else chain
    run_ffmpeg(
        [
            "-i",
            str(src),
            "-map",
            "0:a:0",
            "-af",
            final_chain,
            "-ac",
            str(cfg.channels),
            "-ar",
            str(cfg.sample_rate),
            "-c:a",
            "libmp3lame",
            "-b:a",
            cfg.mp3_bitrate,
            str(dest),
        ],  # fmt: skip
        info.duration,
        (lambda p: on_progress(0.35 + p * 0.65)) if on_progress else None,
    )

    out = probe(dest)
    # The cleaned file must be about as long as the original, or timestamps would drift.
    if abs(out.duration - info.duration) > 2.0:
        raise MediaError(
            f"Cleaned audio is {out.duration:.1f}s but the original is {info.duration:.1f}s."
        )
    return {
        "duration": out.duration,
        "source_duration": info.duration,
        "measured_loudness": float(measured["input_i"]) if measured else None,
        "normalised": measured is not None,
        "hum_notches": list(cfg.hum_hz if cfg.hum_hz is not None else hum),
        "filters": chain,
    }
