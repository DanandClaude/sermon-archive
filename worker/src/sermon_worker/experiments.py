"""Compare cleanup settings on one recording, so they can be tuned on real tapes.

    worker/run.sh -m sermon_worker.experiments tape.mp3 --out /tmp/tape-test
    worker/run.sh -m sermon_worker.experiments tape.mp3 --out /tmp/tape-test --transcribe

Writes one MP3 per variant, then prints loudness and how much of the low-frequency hum is left.
With --transcribe it also transcribes the original and each variant and prints the average word
confidence, which is the number that tells you whether denoising is helping or hurting. (Over-
aggressive denoising can make a tape sound cleaner but transcribe worse.) --transcribe needs the
Whisper model to be installed.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from .clean import CleanConfig, clean_audio
from .media import probe

VARIANTS: dict[str, CleanConfig] = {
    "default": CleanConfig(),
    "declip": CleanConfig(declip=True),
    "denoise": CleanConfig(denoise=True),
    "denoise+declip": CleanConfig(declip=True, denoise=True),
    "declick": CleanConfig(declick=True),
    "strong-denoise": CleanConfig(denoise=True, denoise_reduction_db=20.0),
    "hum-60hz": CleanConfig(hum_hz=(60.0, 120.0, 180.0)),
    "hum-50hz": CleanConfig(hum_hz=(50.0, 100.0, 150.0)),
}


def loudness(path: Path) -> float | None:
    """Integrated loudness in LUFS, or None if it cannot be measured (silence)."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "ebur128=framelog=quiet",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )  # fmt: skip
    found = re.findall(r"I:\s+(-?\d+\.\d+) LUFS", proc.stderr)
    return float(found[-1]) if found else None


def hum_db(path: Path, hz: float = 60.0) -> float:
    """How strong `hz` is compared with the speech band, in dB. Lower means less hum."""
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "8000",
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    )  # fmt: skip
    samples = np.frombuffer(out.stdout, dtype="<f4")
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    freqs = np.fft.rfftfreq(len(samples), 1 / 8000)
    hum = spectrum[(freqs > hz - 3) & (freqs < hz + 3)].max()
    speech = np.sqrt(np.mean(spectrum[(freqs > 300) & (freqs < 3400)] ** 2))
    return float(20 * np.log10(max(hum, 1e-9) / max(speech, 1e-9)))


def run(
    source: Path,
    out_dir: Path,
    variants: dict[str, CleanConfig] | None = None,
    transcriber=None,
) -> list[dict]:
    """Cleans `source` with each variant. Returns one row of measurements per variant."""
    variants = variants or VARIANTS
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = [
        {"variant": "original", "path": source, "lufs": loudness(source), "hum_db": hum_db(source)}
    ]
    for name, cfg in variants.items():
        dest = out_dir / f"{source.stem}.{name}.mp3"
        clean_audio(source, dest, cfg)
        rows.append({"variant": name, "path": dest, "lufs": loudness(dest), "hum_db": hum_db(dest)})
    if transcriber is not None:
        for row in rows:
            result = transcriber.transcribe(row["path"], prompt="", on_progress=lambda p: None)
            words = [w for s in result.segments for w in s.words]
            row["words"] = len(words)
            row["mean_confidence"] = (
                round(sum(w.prob for w in words) / len(words), 3) if words else 0
            )
            row["doubtful"] = len(result.low_confidence(0.5))
    return rows


def format_table(rows: list[dict]) -> str:
    has_words = "words" in rows[0]
    header = f"{'variant':16}{'LUFS':>8}{'hum dB':>9}" + (
        f"{'words':>8}{'confidence':>12}{'doubtful':>10}" if has_words else ""
    )
    lines = [header, "-" * len(header)]
    for r in rows:
        lufs = "n/a" if r["lufs"] is None else f"{r['lufs']:.1f}"
        line = f"{r['variant']:16}{lufs:>8}{r['hum_db']:>9.1f}"
        if has_words:
            line += f"{r['words']:>8}{r['mean_confidence']:>12}{r['doubtful']:>10}"
        lines.append(line)
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("audio", type=Path)
    parser.add_argument(
        "--out", type=Path, default=None, help="where to write the cleaned variants"
    )
    parser.add_argument(
        "--transcribe", action="store_true", help="also compare transcription quality"
    )
    args = parser.parse_args(argv)
    if not args.audio.is_file():
        print(f"No such file: {args.audio}", file=sys.stderr)
        return 2
    probe(args.audio)  # fail early with a clear message if it is not audio

    transcriber = None
    if args.transcribe:
        from .config import REPO_ROOT, from_env, load_env_file
        from .transcribe import make_transcriber

        load_env_file(REPO_ROOT / ".env.local")
        transcriber = make_transcriber(from_env())
    out = args.out or Path(tempfile.mkdtemp(prefix="sermon-experiments-"))
    print(format_table(run(args.audio, out, transcriber=transcriber)))
    print(f"\nListen to the variants in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
