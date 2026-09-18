"""The audio cleanup chain (SPEC section 4.1).

Suggested chain, tuned on real tapes: high-pass, hum notches, FFT denoise, click removal, then
loudness normalisation to about -16 LUFS. Loudness is measured in a first pass and applied in a
second so the result lands on target. Tape wobble and flutter are not corrected.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .media import MediaError, probe, run_ffmpeg


@dataclass(frozen=True)
class CleanConfig:
    highpass_hz: float = 70.0
    # Mains hum and its harmonics. 60 Hz for US recordings; add 50, 100 and 150 for others.
    hum_hz: tuple[float, ...] = (60.0, 120.0, 180.0)
    # Notch sharpness. Lower is wider. Tape speed drift makes hum wander, so a very narrow notch
    # (40) can miss it; this middle value is a starting point to tune on real tapes.
    hum_q: float = 20.0
    denoise: bool = True
    denoise_reduction_db: float = 12.0
    denoise_floor_db: float = -40.0
    declick: bool = True
    target_lufs: float = -16.0
    true_peak_db: float = -1.5
    loudness_range: float = 11.0
    mp3_bitrate: str = "192k"
    sample_rate: int = 44100
    channels: int = 1
    extra_filters: tuple[str, ...] = field(default_factory=tuple)


def build_filters(cfg: CleanConfig) -> list[str]:
    """The filters before loudness normalisation, in order."""
    filters = [f"highpass=f={cfg.highpass_hz:g}"]
    for hz in cfg.hum_hz:
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
    chain = ",".join(build_filters(cfg))

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
        "filters": chain,
    }
