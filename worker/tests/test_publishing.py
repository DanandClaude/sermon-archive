"""Publishing approved sermons to YouTube through the queue, and the podcast's cover art."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import encrypt_json, ffmpeg, make_sermon, make_user
from test_analysis import segments_from

from sermon_worker import publishing
from sermon_worker.media import probe
from sermon_worker.providers import StorageError
from sermon_worker.secrets_box import secrets_key
from sermon_worker.youtube import FakeChannel, QuotaExceeded, UploadedVideo, VideoRejected

TEXT = "Turn with me to Hebrews 13:17. Obey them that have the rule over you. @3 Let us pray."


@pytest.fixture(scope="session")
def cleaned_mp3(audio_dir) -> Path:
    path = audio_dir / "cleaned.mp3"
    ffmpeg("-f", "lavfi", "-i", "sine=f=220:d=4:r=44100", "-ac", "1", "-b:a", "64k", str(path))
    return path


@pytest.fixture()
def sermon(conn, store, cleaned_mp3) -> str:
    sermon = make_sermon(conn, "filed", speaker="Pastor Lee")
    conn.execute(
        "UPDATE sermons SET title = 'Submitting to Leaders', recorded_on = '1988-03-13', duration_sec = 4, "
        "primary_passage = %s WHERE id = %s",
        (
            json.dumps({"book": "Hebrews", "chapter": 13, "verseStart": 17, "verseEnd": None}),
            sermon,
        ),
    )
    key = f"cleaned/{sermon}/job.mp3"
    store.upload(key, cleaned_mp3, "audio/mpeg")
    conn.execute(
        "INSERT INTO audio_assets (sermon_id, kind, storage_key, sha256, bytes, mime, original_filename) "
        "VALUES (%s, 'cleaned', %s, 'x', %s, 'audio/mpeg', 'cleaned.mp3')",
        (sermon, key, cleaned_mp3.stat().st_size),
    )
    conn.execute(
        "INSERT INTO transcripts (sermon_id, version, model, language, full_text, segments, low_confidence) "
        "VALUES (%s, 1, 'test', 'en', %s, %s, '[]')",
        (sermon, TEXT, json.dumps(segments_from(TEXT))),
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('church_name', '\"Grace Church\"') "
        "ON CONFLICT (key) DO NOTHING"
    )
    return sermon


def add_channel(conn, kind="youtube", config=None, settings=None) -> str:
    row = conn.execute(
        "INSERT INTO distribution_channels (kind, provider, encrypted_config, account_label, settings, "
        "connected_at) VALUES (%s::channel_kind, %s, %s, 'Test channel', %s, now()) RETURNING id",
        (
            kind, "fake" if kind == "youtube" else "feed",
            encrypt_json(config or {"kind": "fake"}) if kind == "youtube" else None,
            json.dumps(settings or {}),
        ),
    ).fetchone()  # fmt: skip
    return str(row["id"])


def add_publication(conn, sermon, channel, state="queued", visibility="unlisted", **cols) -> str:
    row = conn.execute(
        "INSERT INTO publications (sermon_id, channel_id, state, visibility, title, description, requested_by) "
        "VALUES (%s, %s, %s::publication_state, %s::visibility, 'Submitting to Leaders', 'A summary.', %s) "
        "RETURNING id",
        (sermon, channel, state, visibility, make_user(conn, "admin")),
    ).fetchone()
    pub = str(row["id"])
    for column, value in cols.items():
        conn.execute(f"UPDATE publications SET {column} = %s WHERE id = %s", (value, pub))
    return pub


def pub_row(conn, pub: str) -> dict:
    return conn.execute("SELECT * FROM publications WHERE id = %s", (pub,)).fetchone()


def youtube_dir(config) -> Path:
    return config.data_dir.parent / "youtube"


class Recording(FakeChannel):
    """The stand-in channel, counting calls and failing on request."""

    def __init__(self, root: Path, fail=None, privacy=None):
        super().__init__(root)
        self.fail, self.privacy = fail, privacy
        self.uploads = 0
        self.privacy_calls: list[tuple[str, str]] = []

    def upload_video(self, source, meta, session, on_session, progress):
        self.uploads += 1
        if self.fail == "after-session":
            on_session("half-done-session")
            raise StorageError("connection dropped")
        if self.fail:
            raise self.fail
        video = super().upload_video(source, meta, session, on_session, progress)
        return UploadedVideo(video.video_id, self.privacy or video.privacy)

    def set_privacy(self, video_id, privacy):
        self.privacy_calls.append((video_id, privacy))
        if self.fail:
            raise self.fail
        return super().set_privacy(video_id, privacy)


def publisher(conn, config, store, channel=None) -> publishing.Publisher:
    channel = channel or Recording(youtube_dir(config))
    return publishing.Publisher(conn, config, store, channel_factory=lambda: ({}, channel))


class TestPublish:
    def test_renders_uploads_adds_captions_and_marks_it_published(
        self, conn, config, store, sermon
    ):
        pub = add_publication(conn, sermon, add_channel(conn))
        assert publishing.Publisher(conn, config, store).run_once()

        row = pub_row(conn, pub)
        assert (row["state"], row["remote_visibility"], row["locked_by"]) == (
            "published",
            "unlisted",
            None,
        )
        assert row["remote_url"] == f"https://www.youtube.com/watch?v={row['remote_id']}"
        assert row["published_at"] and row["first_published_at"] and row["uploaded_at"]
        assert row["captions_id"] and row["upload_session"] is None

        folder = youtube_dir(config) / row["remote_id"]
        meta = json.loads((folder / "video.json").read_text())
        assert meta == {
            "title": "Submitting to Leaders",
            "description": "A summary.",
            "privacy": "unlisted",
        }
        assert "Hebrews 13:17" in (folder / "captions.en.srt").read_text()
        video = probe(folder / "video.mp4")
        assert video.duration == pytest.approx(4, abs=1.2)

        asset = conn.execute(
            "SELECT storage_key, mime FROM audio_assets WHERE sermon_id = %s AND kind = 'video_render'",
            (sermon,),
        ).fetchone()
        assert asset == {"storage_key": f"renders/{sermon}/{pub}.mp4", "mime": "video/mp4"}
        audit = conn.execute("SELECT action, actor_id FROM audit_log").fetchall()
        assert audit == [{"action": "publication.published", "actor_id": None}]

    def test_nothing_queued_means_nothing_to_do(self, conn, config, store):
        assert publishing.Publisher(conn, config, store).run_once() is False

    def test_records_when_youtube_keeps_the_video_private(self, conn, config, store, sermon):
        pub = add_publication(conn, sermon, add_channel(conn), visibility="public")
        channel = Recording(youtube_dir(config), privacy="private")
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["visibility"], row["remote_visibility"]) == (
            "published",
            "public",
            "private",
        )

    def test_a_dropped_upload_resumes_its_session_and_reuses_the_render(
        self, conn, config, store, sermon
    ):
        pub = add_publication(conn, sermon, add_channel(conn))
        channel = Recording(youtube_dir(config), fail="after-session")
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["attempts"], row["upload_session"]) == (
            "queued",
            1,
            "half-done-session",
        )
        assert row["uploaded_at"] is not None and row["last_error"] == "connection dropped"

        seen = {}

        class Resuming(Recording):
            def upload_video(self, source, meta, session, on_session, progress):
                seen["session"] = session
                return super().upload_video(source, meta, session, on_session, progress)

        conn.execute("UPDATE publications SET run_after = now() WHERE id = %s", (pub,))
        publisher(conn, config, store, Resuming(youtube_dir(config))).run_once()
        assert seen["session"] == "half-done-session"
        assert pub_row(conn, pub)["state"] == "published"
        renders = conn.execute(
            "SELECT count(*) AS n FROM audio_assets WHERE kind = 'video_render'"
        ).fetchone()["n"]
        assert renders == 1

    def test_republishing_a_video_already_on_youtube_only_changes_its_privacy(
        self, conn, config, store, sermon
    ):
        channel = Recording(youtube_dir(config))
        folder = youtube_dir(config) / "vid123"
        folder.mkdir(parents=True)
        (folder / "video.json").write_text('{"privacy": "private"}')
        pub = add_publication(
            conn,
            sermon,
            add_channel(conn),
            visibility="public",
            remote_id="vid123",
            captions_id="c1",
        )
        publisher(conn, config, store, channel).run_once()
        assert channel.uploads == 0 and channel.privacy_calls == [("vid123", "public")]
        assert pub_row(conn, pub)["remote_visibility"] == "public"

    def test_a_video_deleted_on_youtube_is_uploaded_again(self, conn, config, store, sermon):
        pub = add_publication(conn, sermon, add_channel(conn), remote_id="gone", captions_id="c1")
        channel = Recording(youtube_dir(config))
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["remote_id"], row["captions_id"]) == ("queued", None, None)
        conn.execute("UPDATE publications SET run_after = now() WHERE id = %s", (pub,))
        publisher(conn, config, store, channel).run_once()
        assert pub_row(conn, pub)["state"] == "published" and channel.uploads == 1

    def test_captions_youtube_refuses_do_not_fail_the_publish(self, conn, config, store, sermon):
        class NoCaptions(Recording):
            def upload_captions(self, video_id, srt, language):
                raise VideoRejected("YouTube refused adding the captions")

        pub = add_publication(conn, sermon, add_channel(conn))
        publisher(conn, config, store, NoCaptions(youtube_dir(config))).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["captions_id"]) == ("published", "refused")


class TestFailures:
    def test_retries_with_backoff_then_fails_with_a_plain_reason(self, conn, config, store, sermon):
        pub = add_publication(conn, sermon, add_channel(conn), max_attempts=2)
        channel = Recording(youtube_dir(config), fail=StorageError("YouTube is busy (status 503)."))
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["attempts"]) == ("queued", 1)
        assert row["run_after"] > row["updated_at"]
        conn.execute("UPDATE publications SET run_after = now() WHERE id = %s", (pub,))
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["last_error"]) == ("failed", "YouTube is busy (status 503).")
        assert row["error_detail"].startswith("StorageError")
        assert (
            conn.execute("SELECT action FROM audit_log").fetchone()["action"]
            == "publication.failed"
        )

    def test_a_spent_quota_waits_without_using_an_attempt(self, conn, config, store, sermon):
        pub = add_publication(conn, sermon, add_channel(conn))
        channel = Recording(youtube_dir(config), fail=QuotaExceeded("quota"))
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["attempts"]) == ("queued", 0)
        assert "daily limit" in row["last_error"]
        waited = conn.execute(
            "SELECT run_after > now() + interval '3 hours' AS later FROM publications WHERE id = %s",
            (pub,),
        ).fetchone()
        assert waited["later"]

    def test_a_deleted_sermon_is_not_published(self, conn, config, store, sermon):
        pub = add_publication(conn, sermon, add_channel(conn))
        conn.execute("UPDATE sermons SET deleted_at = now() WHERE id = %s", (sermon,))
        channel = Recording(youtube_dir(config))
        publisher(conn, config, store, channel).run_once()
        assert pub_row(conn, pub)["state"] == "failed" and channel.uploads == 0

    def test_never_uses_a_real_account_outside_production_mode(self, conn, config, store, sermon):
        channel = add_channel(conn, config={"kind": "youtube", "refreshToken": "rt"})
        pub = add_publication(conn, sermon, channel)
        publishing.Publisher(conn, config, store).run_once()
        row = pub_row(conn, pub)
        assert row["state"] == "failed" and "production mode" in row["last_error"]

    def test_a_disconnected_channel_asks_for_a_reconnect(self, conn, config, store, sermon):
        channel = add_channel(conn)
        pub = add_publication(conn, sermon, channel)
        conn.execute(
            "UPDATE distribution_channels SET disconnected_at = now(), encrypted_config = NULL"
        )
        publishing.Publisher(conn, config, store).run_once()
        assert "Connect it on the Connections page" in pub_row(conn, pub)["last_error"]

    def test_the_test_channel_is_refused_in_production(self, conn, config, store):
        add_channel(conn)
        with pytest.raises(Exception, match="cannot be used in production"):
            # The same key the test row was encrypted with, so only the production rule can refuse it.
            key = secrets_key(None, False).hex()
            publishing.load_channel(conn, replace(config, node_env="production", secrets_key=key))

    def test_a_vanished_worker_gives_its_publication_back(self, conn, sermon):
        pub = add_publication(conn, sermon, add_channel(conn), state="publishing", locked_by="gone")
        conn.execute(
            "UPDATE publications SET heartbeat_at = now() - interval '1 hour' WHERE id = %s", (pub,)
        )
        assert publishing.reap_stale(conn, 600) == 1
        row = pub_row(conn, pub)
        assert (row["state"], row["locked_by"]) == ("queued", None)


class TestDailyLimit:
    def test_new_uploads_wait_once_the_days_limit_is_used(self, conn, config, sermon):
        channel = add_channel(conn, settings={"dailyUploads": 1})
        add_publication(conn, sermon, channel, state="published", uploaded_at="now()")
        other = make_sermon(conn, "filed")
        add_publication(conn, other, channel)
        assert publishing.claim(conn, "w") is None

    def test_unpublishing_and_resuming_do_not_wait_for_the_limit(self, conn, sermon):
        channel = add_channel(conn, settings={"dailyUploads": 1})
        add_publication(
            conn, make_sermon(conn, "filed"), channel, state="published", uploaded_at="now()"
        )
        resuming = add_publication(conn, make_sermon(conn, "filed"), channel, upload_session="s")
        removing = add_publication(conn, sermon, channel, state="removing", remote_id="v")
        assert str(publishing.claim(conn, "w")["id"]) == removing
        assert str(publishing.claim(conn, "w")["id"]) == resuming

    def test_uploads_older_than_a_day_do_not_count(self, conn, sermon):
        channel = add_channel(conn, settings={"dailyUploads": 1})
        add_publication(
            conn, make_sermon(conn, "filed"), channel, state="published",
            uploaded_at="2020-01-01T00:00:00Z",
        )  # fmt: skip
        pub = add_publication(conn, sermon, channel)
        claimed = publishing.claim(conn, "w")
        assert str(claimed["id"]) == pub and claimed["state"] == "publishing"

    def test_podcast_rows_are_never_claimed(self, conn, sermon):
        add_publication(conn, sermon, add_channel(conn, "podcast"))
        assert publishing.claim(conn, "w") is None


class TestUnpublish:
    def test_makes_the_video_private_and_marks_it_removed(self, conn, config, store, sermon):
        folder = youtube_dir(config) / "vid9"
        folder.mkdir(parents=True)
        (folder / "video.json").write_text('{"privacy": "public"}')
        pub = add_publication(conn, sermon, add_channel(conn), state="removing", remote_id="vid9")
        publisher(conn, config, store).run_once()
        row = pub_row(conn, pub)
        assert (row["state"], row["remote_visibility"]) == ("removed", "private")
        assert json.loads((folder / "video.json").read_text())["privacy"] == "private"
        assert (
            conn.execute("SELECT action FROM audit_log").fetchone()["action"]
            == "publication.removed"
        )

    def test_a_failed_unpublish_leaves_it_published_with_the_reason(
        self, conn, config, store, sermon
    ):
        pub = add_publication(
            conn, sermon, add_channel(conn), state="removing", remote_id="v", max_attempts=1
        )
        channel = Recording(youtube_dir(config), fail=StorageError("YouTube is busy."))
        publisher(conn, config, store, channel).run_once()
        row = pub_row(conn, pub)
        assert row["state"] == "published"
        assert row["last_error"] == "Could not make the video private: YouTube is busy."

    def test_removing_a_deleted_sermon_still_works(self, conn, config, store, sermon):
        (youtube_dir(config) / "v").mkdir(parents=True)
        (youtube_dir(config) / "v" / "video.json").write_text("{}")
        pub = add_publication(conn, sermon, add_channel(conn), state="removing", remote_id="v")
        conn.execute("UPDATE sermons SET deleted_at = now() WHERE id = %s", (sermon,))
        publisher(conn, config, store).run_once()
        assert pub_row(conn, pub)["state"] == "removed"


class TestCoverText:
    def test_matches_what_the_dialog_previews(self, conn, sermon):
        s = conn.execute("SELECT * FROM sermons WHERE id = %s", (sermon,)).fetchone()
        assert publishing.cover_text(conn, s) == {
            "church": "Grace Church",
            "title": "Submitting to Leaders",
            "passage": "Hebrews 13:17",
            "date": "March 13, 1988",
        }


class TestPodcastArtwork:
    def test_draws_once_and_again_when_the_name_changes(self, conn, store, sermon):
        assert publishing.ensure_podcast_artwork(conn, store) is False  # podcast is off
        channel = add_channel(conn, "podcast", settings={"title": "Grace Sermons"})
        assert publishing.ensure_podcast_artwork(conn, store) is True
        first = conn.execute(
            "SELECT artwork_key FROM distribution_channels WHERE id = %s", (channel,)
        ).fetchone()
        assert store.exists(first["artwork_key"])
        assert publishing.ensure_podcast_artwork(conn, store) is False
        conn.execute(
            'UPDATE distribution_channels SET settings = \'{"title": "New Name"}\' WHERE id = %s',
            (channel,),
        )
        assert publishing.ensure_podcast_artwork(conn, store) is True
        second = conn.execute(
            "SELECT artwork_key FROM distribution_channels WHERE id = %s", (channel,)
        ).fetchone()
        assert second["artwork_key"] != first["artwork_key"]
