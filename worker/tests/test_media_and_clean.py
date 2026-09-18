from __future__ import annotations

import hashlib
import math

import pytest
from conftest import decode_mono, integrated_lufs, tone_magnitude

from sermon_worker.clean import CleanConfig, build_filters, clean_audio, parse_loudnorm
from sermon_worker.media import MediaError, compute_peaks, probe, run_ffmpeg


def sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestProbe:
    def test_reads_duration_rate_and_channels(self, hummy_wav):
        info = probe(hummy_wav)
        assert info.duration == pytest.approx(8.0, abs=0.05)
        assert (info.sample_rate, info.channels) == (44100, 1)

    def test_rejects_a_file_that_is_not_audio(self, not_audio):
        with pytest.raises(MediaError, match="Could not read"):
            probe(not_audio)

    def test_rejects_a_missing_file(self, tmp_path):
        with pytest.raises(MediaError):
            probe(tmp_path / "nope.wav")


class TestRunFfmpeg:
    def test_reports_steady_progress_up_to_the_end(self, hummy_wav, tmp_path):
        seen: list[float] = []
        run_ffmpeg(
            ["-i", str(hummy_wav), "-af", "volume=0.5", str(tmp_path / "o.wav")], 8.0, seen.append
        )
        assert seen and all(0 <= p <= 1 for p in seen)
        assert seen == sorted(seen)
        assert seen[-1] > 0.9

    def test_failure_includes_what_ffmpeg_said(self, tmp_path):
        with pytest.raises(MediaError, match="ffmpeg failed"):
            run_ffmpeg(["-i", str(tmp_path / "missing.wav"), str(tmp_path / "o.wav")], 1.0)


class TestPeaks:
    def test_two_buckets_per_second_all_between_zero_and_one(self, hummy_wav):
        peaks = compute_peaks(hummy_wav)
        assert peaks["version"] == 1
        assert peaks["duration"] == pytest.approx(8.0, abs=0.1)
        assert len(peaks["peaks"]) == 16
        assert all(0 <= p <= 1 for p in peaks["peaks"])
        assert peaks["bucketSeconds"] == pytest.approx(0.5, abs=0.02)

    def test_shows_where_the_sound_is(self, half_silent_wav):
        peaks = compute_peaks(half_silent_wav)["peaks"]
        quiet, loud = peaks[: len(peaks) // 2 - 1], peaks[len(peaks) // 2 + 1 :]
        assert max(quiet) < 0.05
        assert min(loud) > 0.3

    def test_is_capped_for_very_long_audio(self, hummy_wav):
        assert len(compute_peaks(hummy_wav, buckets_per_second=1000, max_buckets=50)["peaks"]) == 50

    def test_rejects_a_file_that_is_not_audio(self, not_audio):
        with pytest.raises(MediaError):
            compute_peaks(not_audio)


class TestBuildFilters:
    def test_default_chain_is_in_the_documented_order(self):
        chain = build_filters(CleanConfig())
        names = [f.split("=")[0] for f in chain]
        assert names == ["highpass", "bandreject", "bandreject", "bandreject", "afftdn", "adeclick"]
        assert chain[0] == "highpass=f=70"
        assert {f.split(":")[0] for f in chain[1:4]} == {
            "bandreject=f=60",
            "bandreject=f=120",
            "bandreject=f=180",
        }

    def test_can_switch_stages_off_and_add_50_hz_hum(self):
        chain = build_filters(CleanConfig(denoise=False, declick=False, hum_hz=(50.0, 100.0)))
        assert [f.split("=")[0] for f in chain] == ["highpass", "bandreject", "bandreject"]


class TestParseLoudnorm:
    GOOD = 'noise {\n\t"input_i" : "-23.5",\n\t"input_tp" : "-4.1",\n\t"input_lra" : "3.2",\n\t"input_thresh" : "-33.9",\n\t"target_offset" : "0.4"\n}'

    def test_reads_the_measurement(self):
        assert parse_loudnorm(self.GOOD)["input_i"] == "-23.5"

    def test_returns_none_for_silence(self):
        assert parse_loudnorm(self.GOOD.replace("-23.5", "-inf")) is None

    def test_returns_none_when_there_is_no_measurement(self):
        assert parse_loudnorm("nothing to see") is None
        assert parse_loudnorm("{ not json }") is None


@pytest.fixture(scope="module")
def cleaned(hummy_wav, tmp_path_factory):
    dest = tmp_path_factory.mktemp("out") / "cleaned.mp3"
    progress: list[float] = []
    before = sha(hummy_wav)
    result = clean_audio(hummy_wav, dest, on_progress=progress.append)
    return dest, result, progress, before


class TestCleanAudio:
    def test_removes_the_hum_and_keeps_the_voice(self, hummy_wav, cleaned):
        dest, *_ = cleaned
        before, after = decode_mono(hummy_wav), decode_mono(dest)
        ratio_before = tone_magnitude(before, 60) / tone_magnitude(before, 300)
        ratio_after = tone_magnitude(after, 60) / tone_magnitude(after, 300)
        assert ratio_before > 0.5  # the hum really was there
        assert ratio_after < ratio_before / 10  # at least 20 dB quieter relative to the voice
        assert tone_magnitude(after, 300) > 0  # and the voice is still there

    def test_lands_close_to_the_loudness_target(self, cleaned):
        dest, *_ = cleaned
        assert integrated_lufs(dest) == pytest.approx(-16.0, abs=1.5)

    def test_writes_a_192k_mono_mp3_of_the_same_length(self, cleaned):
        dest, result, *_ = cleaned
        info = probe(dest)
        assert (info.codec, info.channels, info.sample_rate) == ("mp3", 1, 44100)
        assert info.duration == pytest.approx(8.0, abs=0.2)
        assert result["normalised"] is True
        assert result["duration"] == pytest.approx(result["source_duration"], abs=0.2)

    def test_never_changes_the_original(self, hummy_wav, cleaned):
        *_, before = cleaned
        assert sha(hummy_wav) == before

    def test_reports_progress_across_both_passes(self, cleaned):
        *_, progress, _ = cleaned
        assert progress == sorted(progress)
        assert progress[0] < 0.4 and progress[-1] > 0.9

    def test_silence_is_handled_without_normalising(self, silent_wav, tmp_path):
        dest = tmp_path / "s.mp3"
        result = clean_audio(silent_wav, dest)
        assert result["normalised"] is False
        assert probe(dest).duration == pytest.approx(3.0, abs=0.2)

    def test_a_file_that_is_not_audio_fails_clearly_and_leaves_nothing(self, not_audio, tmp_path):
        dest = tmp_path / "x.mp3"
        with pytest.raises(MediaError):
            clean_audio(not_audio, dest)
        assert not dest.exists()

    def test_gain_is_sane(self, cleaned):
        dest, *_ = cleaned
        peak = max(abs(decode_mono(dest)))
        assert peak <= 1.0 and not math.isnan(peak)
