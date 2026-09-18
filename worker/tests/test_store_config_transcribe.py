from __future__ import annotations

from types import SimpleNamespace

import pytest

from sermon_worker import pipeline
from sermon_worker.config import ConfigError, from_env, load_env_file
from sermon_worker.store import (
    InvalidKeyError,
    LocalStore,
    ObjectNotFound,
    ProtectedKeyError,
    S3Store,
)
from sermon_worker.transcribe import (
    FakeTranscriber,
    FasterWhisperTranscriber,
    ModelNotAvailable,
    Segment,
    TranscriptResult,
    Word,
    build_prompt,
    make_transcriber,
)

BASE_ENV = {"DATABASE_URL": "postgres://localhost/x_test"}


class TestLocalStore:
    def test_round_trips_a_file(self, tmp_path):
        store = LocalStore(tmp_path / "root")
        src = tmp_path / "a.mp3"
        src.write_bytes(b"audio")
        store.upload("cleaned/s1/j1.mp3", src, "audio/mpeg")
        out = tmp_path / "b.mp3"
        store.download("cleaned/s1/j1.mp3", out)
        assert out.read_bytes() == b"audio"
        assert store.exists("cleaned/s1/j1.mp3")

    def test_uses_the_same_layout_as_the_app(self, tmp_path):
        store = LocalStore(tmp_path)
        store.upload_bytes("peaks/s1/x.json", b"{}", "application/json")
        assert (tmp_path / "objects" / "peaks" / "s1" / "x.json").read_bytes() == b"{}"

    @pytest.mark.parametrize("key", ["originals/s1/original.wav", "originals/x"])
    def test_never_writes_under_originals(self, tmp_path, key):
        store = LocalStore(tmp_path)
        src = tmp_path / "a.wav"
        src.write_bytes(b"x")
        with pytest.raises(ProtectedKeyError):
            store.upload(key, src, "audio/wav")
        with pytest.raises(ProtectedKeyError):
            store.upload_bytes(key, b"x", "audio/wav")
        assert not (tmp_path / "objects" / key).exists()

    def test_can_still_read_originals(self, tmp_path):
        original = tmp_path / "objects" / "originals" / "s1" / "original.wav"
        original.parent.mkdir(parents=True)
        original.write_bytes(b"tape")
        out = tmp_path / "copy.wav"
        LocalStore(tmp_path).download("originals/s1/original.wav", out)
        assert out.read_bytes() == b"tape"

    @pytest.mark.parametrize("key", ["", "../x", "/abs", "a//b", "a/../b", "a\\b", "./a"])
    def test_rejects_unsafe_keys(self, tmp_path, key):
        store = LocalStore(tmp_path)
        with pytest.raises(InvalidKeyError):
            store.download(key, tmp_path / "o")
        with pytest.raises(InvalidKeyError):
            store.upload_bytes(key, b"x", "text/plain")

    def test_missing_object_is_reported(self, tmp_path):
        with pytest.raises(ObjectNotFound):
            LocalStore(tmp_path).download("cleaned/none.mp3", tmp_path / "o")

    def test_leaves_no_partial_files_behind(self, tmp_path):
        store = LocalStore(tmp_path)
        store.upload_bytes("cleaned/s1/a.mp3", b"abc", "audio/mpeg")
        leftovers = [p.name for p in (tmp_path / "objects" / "cleaned" / "s1").iterdir()]
        assert leftovers == ["a.mp3"]

    def test_a_retry_may_replace_its_own_derived_output(self, tmp_path):
        store = LocalStore(tmp_path)
        store.upload_bytes("cleaned/s1/j1.mp3", b"first", "audio/mpeg")
        store.upload_bytes("cleaned/s1/j1.mp3", b"second", "audio/mpeg")
        out = tmp_path / "o"
        store.download("cleaned/s1/j1.mp3", out)
        assert out.read_bytes() == b"second"


class TestS3Store:
    class Client:
        def __init__(self):
            self.calls = []

        def upload_file(self, *args, **kwargs):
            self.calls.append(("upload_file", args, kwargs))

        def put_object(self, **kwargs):
            self.calls.append(("put_object", kwargs))

    def test_uploads_with_a_content_type(self, tmp_path):
        client = self.Client()
        src = tmp_path / "a.mp3"
        src.write_bytes(b"x")
        S3Store("bucket", "us-east-1", client=client).upload("cleaned/s1/a.mp3", src, "audio/mpeg")
        assert client.calls[0][2]["ExtraArgs"] == {"ContentType": "audio/mpeg"}
        assert client.calls[0][1][1:3] == ("bucket", "cleaned/s1/a.mp3")

    def test_refuses_to_write_originals(self, tmp_path):
        client = self.Client()
        store = S3Store("bucket", "us-east-1", client=client)
        with pytest.raises(ProtectedKeyError):
            store.upload_bytes("originals/s1/original.wav", b"x", "audio/wav")
        assert client.calls == []


class TestConfig:
    def test_needs_a_database_url(self):
        with pytest.raises(ConfigError, match="DATABASE_URL"):
            from_env({})

    def test_defaults_are_safe_for_development(self):
        cfg = from_env(BASE_ENV)
        assert (cfg.adapter_mode, cfg.transcriber, cfg.whisper_model, cfg.whisper_compute_type) == (
            "fake", "whisper", "large-v3", "int8",
        )  # fmt: skip
        assert cfg.allow_model_download is False
        assert cfg.transcribe_source == "cleaned"

    def test_real_mode_is_refused_outside_production(self):
        with pytest.raises(ConfigError, match="only allowed when NODE_ENV=production"):
            from_env({**BASE_ENV, "ADAPTER_MODE": "real", "S3_BUCKET": "b", "S3_REGION": "r"})

    def test_real_mode_needs_a_bucket(self):
        with pytest.raises(ConfigError, match="S3_BUCKET"):
            from_env({**BASE_ENV, "NODE_ENV": "production", "ADAPTER_MODE": "real"})

    def test_real_mode_works_in_production_with_a_bucket(self):
        cfg = from_env(
            {
                **BASE_ENV,
                "NODE_ENV": "production",
                "ADAPTER_MODE": "real",
                "S3_BUCKET": "b",
                "S3_REGION": "r",
            }
        )
        assert cfg.real_mode and cfg.s3_bucket == "b"

    def test_the_scripted_transcriber_is_refused_in_production(self):
        with pytest.raises(ConfigError, match="not allowed in production"):
            from_env({**BASE_ENV, "NODE_ENV": "production", "TRANSCRIBER": "fake"})

    @pytest.mark.parametrize(
        "extra", [{"TRANSCRIBER": "gpt"}, {"ADAPTER_MODE": "live"}, {"TRANSCRIBE_SOURCE": "both"}]
    )
    def test_rejects_unknown_choices(self, extra):
        with pytest.raises(ConfigError):
            from_env({**BASE_ENV, **extra})

    def test_env_file_fills_gaps_without_overriding(self, tmp_path):
        f = tmp_path / ".env.local"
        f.write_text('# c\nDATABASE_URL=postgres://a\nQUOTED="hi there"\nEMPTY=\nnoequals\n')
        env = {"DATABASE_URL": "postgres://already"}
        load_env_file(f, env)
        assert env["DATABASE_URL"] == "postgres://already"
        assert env["QUOTED"] == "hi there"
        load_env_file(tmp_path / "missing", env)


class TestPipelineFile:
    def test_transitions_are_read_from_the_shared_file(self):
        assert pipeline.can_transition("uploaded", "cleaning")
        assert not pipeline.can_transition("uploaded", "transcribing")
        with pytest.raises(pipeline.InvalidTransition):
            pipeline.assert_transition("filed", "uploading")

    def test_bible_books_are_the_66_book_canon(self):
        books = pipeline.bible_books()
        assert len(books) == 66 and len(set(books)) == 66
        assert books[0] == "Genesis" and books[-1] == "Revelation"


class TestPrompt:
    def test_has_every_book_and_puts_the_speaker_last(self):
        prompt = build_prompt("Pastor Lee")
        assert all(b in prompt for b in pipeline.bible_books())
        assert prompt.endswith("A sermon by Pastor Lee.")

    def test_works_without_a_speaker_and_stays_short(self):
        assert "sermon by" not in build_prompt(None)
        assert "sermon by" not in build_prompt("   ")
        assert len(build_prompt("A" * 30)) < 1100


def _words(*items):
    return [Word(w, s, e, p) for w, s, e, p in items]


class TestTranscriptResult:
    result = TranscriptResult(
        segments=[
            Segment(0.0, 2.0, " Turn to Hebrews. ", _words((" Turn", 0.0, 0.4, 0.99), (" to", 0.4, 0.6, 0.98), (" Hebrews.", 0.6, 2.0, 0.42))),
            Segment(2.0, 3.5, "", []),
            Segment(3.5, 6.0, " Amen ", _words((" Amen", 3.5, 6.0, 0.5))),
        ],
        language="en", model="m", duration=6.0,
    )  # fmt: skip

    def test_full_text_skips_empty_segments_and_trims(self):
        assert self.result.full_text == "Turn to Hebrews. Amen"

    def test_flags_only_words_below_the_threshold(self):
        assert self.result.low_confidence(0.5) == [[0, 2]]
        assert self.result.low_confidence(0.6) == [[0, 2], [2, 0]]
        assert self.result.low_confidence(0.1) == []

    def test_json_is_trimmed_and_rounded(self):
        first = self.result.segments_json()[0]
        assert first["text"] == "Turn to Hebrews."
        assert first["words"][2] == {"w": "Hebrews.", "start": 0.6, "end": 2.0, "prob": 0.42}


class StubModel:
    def __init__(self, segments, duration):
        self.calls = []
        self._segments, self._duration = segments, duration

    def transcribe(self, path, **kwargs):
        self.calls.append((path, kwargs))
        return iter(self._segments), SimpleNamespace(duration=self._duration)


def _seg(start, end, text, words):
    return SimpleNamespace(
        start=start, end=end, text=text,
        words=[SimpleNamespace(word=w, start=s, end=e, probability=p) for w, s, e, p in words],
    )  # fmt: skip


class TestFasterWhisperTranscriber:
    def make(self, model):
        t = FasterWhisperTranscriber("large-v3")
        t._model = model
        return t

    def test_asks_for_word_timings_and_guards_against_hallucination(self, tmp_path):
        model = StubModel([], 10)
        self.make(model).transcribe(tmp_path / "a.mp3", prompt="P", on_progress=lambda p: None)
        _, kw = model.calls[0]
        assert (
            kw["language"] == "en" and kw["word_timestamps"] is True and kw["initial_prompt"] == "P"
        )
        assert kw["vad_filter"] is True and kw["condition_on_previous_text"] is False
        assert (
            kw["hallucination_silence_threshold"] == 2.0
            and kw["compression_ratio_threshold"] == 2.4
        )

    def test_converts_segments_and_reports_progress(self, tmp_path):
        model = StubModel(
            [
                _seg(0, 4, " One ", [(" One", 0, 4, 0.9)]),
                _seg(4, 10, " Two ", [(" Two", 4, 10, 0.3)]),
            ],
            10,
        )
        seen: list[float] = []
        result = self.make(model).transcribe(tmp_path / "a.mp3", prompt="", on_progress=seen.append)
        assert [s.text for s in result.segments] == [" One ", " Two "]
        assert result.segments[1].words[0].prob == 0.3
        assert seen == [0.4, 0.99] and result.language == "en"
        assert result.model == "faster-whisper:large-v3:int8"

    def test_a_missing_model_is_explained_instead_of_downloaded(self, monkeypatch):
        import faster_whisper

        def boom(*a, **k):
            raise OSError("not in cache")

        monkeypatch.setattr(faster_whisper, "WhisperModel", boom)
        with pytest.raises(ModelNotAvailable, match="fetch_model large-v3"):
            FasterWhisperTranscriber("large-v3")._load()

    def test_never_asks_the_library_to_download_unless_allowed(self, monkeypatch):
        import faster_whisper

        seen = {}

        def capture(source, **kwargs):
            seen.update(kwargs, source=source)
            return object()

        monkeypatch.setattr(faster_whisper, "WhisperModel", capture)
        FasterWhisperTranscriber("large-v3")._load()
        assert seen["local_files_only"] is True
        seen.clear()
        FasterWhisperTranscriber("large-v3", allow_download=True)._load()
        assert seen["local_files_only"] is False
        seen.clear()
        FasterWhisperTranscriber("large-v3", model_path="/models/x")._load()
        assert seen["source"] == "/models/x"


class TestFakeTranscriber:
    def test_covers_the_whole_recording_with_timed_words_and_a_doubtful_word(self, hummy_wav):
        seen: list[float] = []
        result = FakeTranscriber().transcribe(hummy_wav, prompt="", on_progress=seen.append)
        assert result.segments[0].start == 0 and result.segments[-1].end == pytest.approx(
            8.0, abs=0.1
        )
        assert all(
            a.end <= b.start + 1e-9
            for a, b in zip(result.segments, result.segments[1:], strict=False)
        )
        assert result.low_confidence(0.5)
        assert seen == sorted(seen)
        assert "Hebrews" in result.full_text

    def test_is_chosen_by_config_and_says_what_it_is(self):
        assert (
            make_transcriber(from_env({**BASE_ENV, "TRANSCRIBER": "fake"})).name == "fake:scripted"
        )
        assert make_transcriber(from_env(BASE_ENV)).name == "faster-whisper:large-v3:int8"
