from __future__ import annotations

import pytest

from sermon_worker.clean import CleanConfig
from sermon_worker.experiments import VARIANTS, format_table, hum_db, loudness, main, run
from sermon_worker.transcribe import FakeTranscriber

QUICK = {"default": CleanConfig(), "denoise": CleanConfig(denoise=True)}


def test_measures_hum_and_loudness_of_a_recording(hummy_wav):
    assert hum_db(hummy_wav, 60) > -20  # the 60 Hz hum is clearly there
    assert loudness(hummy_wav) is not None


def test_each_variant_writes_a_file_and_the_default_removes_hum(hummy_wav, tmp_path):
    rows = run(hummy_wav, tmp_path, QUICK)
    assert [r["variant"] for r in rows] == ["original", "default", "denoise"]
    assert all(r["path"].exists() for r in rows)
    original, default = rows[0], rows[1]
    assert default["hum_db"] < original["hum_db"] - 15
    assert default["lufs"] == pytest.approx(-16.0, abs=1.5)


def test_can_compare_transcription_quality_across_variants(hummy_wav, tmp_path):
    rows = run(hummy_wav, tmp_path, QUICK, transcriber=FakeTranscriber())
    assert all(r["words"] > 0 and 0 < r["mean_confidence"] <= 1 for r in rows)
    table = format_table(rows)
    assert "confidence" in table and "denoise" in table


def test_table_without_transcription_has_just_loudness_and_hum(hummy_wav, tmp_path):
    table = format_table(run(hummy_wav, tmp_path, QUICK))
    assert "hum dB" in table and "confidence" not in table


def test_the_built_in_variants_cover_the_options_worth_comparing():
    assert VARIANTS["hum-50hz"].hum_hz == (50.0, 100.0, 150.0)
    assert VARIANTS["declip"].declip and VARIANTS["denoise"].denoise
    assert not VARIANTS["default"].denoise and not VARIANTS["default"].declip


def test_the_command_line_refuses_a_missing_file(tmp_path, capsys):
    assert main([str(tmp_path / "nope.mp3")]) == 2
    assert "No such file" in capsys.readouterr().err
