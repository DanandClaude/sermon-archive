"""Publishing approved sermons to YouTube, and drawing the podcast's cover art.

An admin presses Publish in the app, which adds a `publications` row in state `queued` with the
title and description they previewed. This worker claims it (FOR UPDATE SKIP LOCKED, like jobs),
draws the cover, renders a still-image video from the cleaned audio, uploads it with a resumable
session, adds the captions, and marks it `published`. Unpublish (`removing`) makes the video
private. Nothing here deletes a video.

The podcast needs no worker for its episodes (the app serves the feed), only for its cover art.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Callable
from datetime import date
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .config import Config
from .cover import render_artwork, render_cover
from .media import MediaError, render_video
from .providers import ProviderRejected, StorageError
from .queue import PermanentError
from .render import to_srt
from .scripture import Reference, format_reference
from .secrets_box import SecretsError, decrypt_json, secrets_key
from .store import ObjectNotFound, ObjectStore
from .youtube import (
    FakeChannel,
    QuotaExceeded,
    UploadedVideo,
    VideoChannel,
    VideoMeta,
    VideoRejected,
    YouTubeChannel,
)

# Wait this long after the 1st, 2nd, 3rd... failed attempt before trying again.
BACKOFF_SECONDS = (60, 300, 900, 3600)
# YouTube's quota resets once a day; looking again a few hours later is soon enough.
QUOTA_WAIT_SECONDS = 4 * 3600
DEFAULT_DAILY_UPLOADS = 5
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")  # fmt: skip


class SermonGone(PermanentError):
    pass


# -- the channel ------------------------------------------------------------------------------


def load_channel(conn: psycopg.Connection, config: Config) -> tuple[dict, VideoChannel]:
    row = conn.execute(
        "SELECT * FROM distribution_channels WHERE kind = 'youtube' "
        "AND connected_at IS NOT NULL AND disconnected_at IS NULL"
    ).fetchone()
    if row is None or not row["encrypted_config"]:
        raise ProviderRejected("YouTube is not connected. Connect it on the Connections page.")
    try:
        settings = decrypt_json(
            row["encrypted_config"],
            secrets_key(config.secrets_key, config.node_env == "production"),
        )
    except SecretsError as error:
        raise ProviderRejected(
            "The saved YouTube sign-in could not be read. Reconnect YouTube on the Connections page."
        ) from error

    if settings.get("kind") == "fake":
        if config.node_env == "production":
            raise ProviderRejected("The development test channel cannot be used in production.")
        return row, FakeChannel(config.data_dir.parent / "youtube")
    if settings.get("kind") == "youtube":
        if not config.real_mode:
            # Nothing is published to a real account from development or tests.
            raise ProviderRejected(
                "YouTube is only used when the app runs in production mode (ADAPTER_MODE=real)."
            )
        return row, YouTubeChannel(
            client_id=config.google_client_id or "",
            client_secret=config.google_client_secret or "",
            refresh_token=settings["refreshToken"],
        )
    raise ProviderRejected("This YouTube connection uses a provider this worker does not know.")


# -- the queue --------------------------------------------------------------------------------


def claim(conn: psycopg.Connection, worker_id: str) -> dict | None:
    """Takes the next due YouTube publication. New uploads wait while today's limit is used up;
    unpublishing, resuming an upload and republishing an existing video never wait for it."""
    return conn.execute(
        """
        UPDATE publications p
        SET locked_by = %(worker)s, heartbeat_at = now(), attempts = p.attempts + 1,
            state = CASE WHEN p.state = 'queued' THEN 'publishing'::publication_state ELSE p.state END,
            updated_at = now()
        WHERE p.id = (
          SELECT q.id FROM publications q
          JOIN distribution_channels c ON c.id = q.channel_id
          WHERE c.kind = 'youtube' AND q.state IN ('queued', 'removing') AND q.locked_by IS NULL
            AND q.run_after <= now()
            AND (q.state = 'removing' OR q.remote_id IS NOT NULL OR q.upload_session IS NOT NULL
                 OR (SELECT count(*) FROM publications u
                     WHERE u.channel_id = c.id AND u.uploaded_at > now() - interval '24 hours')
                    < COALESCE((c.settings ->> 'dailyUploads')::int, %(daily)s))
          ORDER BY (q.state = 'removing') DESC, q.requested_at, q.id
          LIMIT 1 FOR UPDATE OF q SKIP LOCKED
        )
        RETURNING p.*
        """,
        {"worker": worker_id, "daily": DEFAULT_DAILY_UPLOADS},
    ).fetchone()


def reap_stale(conn: psycopg.Connection, stale_seconds: int) -> int:
    """Takes back publications whose worker vanished. The attempt they were on still counts."""
    rows = conn.execute(
        """
        UPDATE publications SET locked_by = NULL, updated_at = now(),
          state = CASE WHEN state = 'publishing' THEN 'queued'::publication_state ELSE state END
        WHERE locked_by IS NOT NULL AND heartbeat_at < now() - make_interval(secs => %s)
        RETURNING id
        """,
        (stale_seconds,),
    ).fetchall()
    return len(rows)


def _heartbeat(conn: psycopg.Connection, pub_id: str) -> None:
    conn.execute("UPDATE publications SET heartbeat_at = now() WHERE id = %s", (pub_id,))


def friendly(error: Exception) -> str:
    """What the admin sees. The full detail goes in `error_detail`."""
    if isinstance(error, ObjectNotFound):
        return "The sermon's audio could not be found in storage."
    if isinstance(error, MediaError):
        return "The video could not be made from the audio. It may be damaged."
    if isinstance(error, (PermanentError, StorageError)):
        return str(error)[:300]
    return "Something went wrong while publishing to YouTube."


def _audit(conn: psycopg.Connection, action: str, pub: dict, extra: dict | None = None) -> None:
    conn.execute(
        "INSERT INTO audit_log (actor_id, action, entity, entity_id, diff) "
        "VALUES (NULL, %s, 'sermon', %s, %s)",
        (action, pub["sermon_id"], Jsonb({"channel": "youtube", "publicationId": str(pub["id"]), **(extra or {})})),
    )  # fmt: skip


def _fail_attempt(conn: psycopg.Connection, pub: dict, error: Exception) -> str:
    detail = f"{type(error).__name__}: {error}"[:1000]
    message = friendly(error)
    removing = pub["state"] == "removing"
    if isinstance(error, QuotaExceeded):
        # Not the publication's fault: wait for the quota without using up an attempt.
        conn.execute(
            "UPDATE publications SET locked_by = NULL, attempts = attempts - 1, updated_at = now(), "
            "state = CASE WHEN state = 'publishing' THEN 'queued'::publication_state ELSE state END, "
            "run_after = now() + make_interval(secs => %s), last_error = %s, error_detail = %s "
            "WHERE id = %s",
            (QUOTA_WAIT_SECONDS,
             "YouTube's daily limit was reached. This will carry on in a few hours.",
             detail, pub["id"]),
        )  # fmt: skip
        return "waiting"
    permanent = isinstance(error, PermanentError)
    if not permanent and pub["attempts"] < pub["max_attempts"]:
        delay = BACKOFF_SECONDS[min(pub["attempts"], len(BACKOFF_SECONDS)) - 1]
        conn.execute(
            "UPDATE publications SET locked_by = NULL, updated_at = now(), "
            "state = CASE WHEN state = 'publishing' THEN 'queued'::publication_state ELSE state END, "
            "run_after = now() + make_interval(secs => %s), last_error = %s, error_detail = %s "
            "WHERE id = %s",
            (delay, message, detail, pub["id"]),
        )
        return "retry"
    with conn.transaction():
        if removing:
            # The video is still up as it was; say so, and let the admin try again.
            conn.execute(
                "UPDATE publications SET locked_by = NULL, state = 'published', updated_at = now(), "
                "removed_by = NULL, last_error = %s, error_detail = %s WHERE id = %s",
                (f"Could not make the video private: {message}"[:300], detail, pub["id"]),
            )
        else:
            conn.execute(
                "UPDATE publications SET locked_by = NULL, state = 'failed', updated_at = now(), "
                "last_error = %s, error_detail = %s WHERE id = %s",
                (message, detail, pub["id"]),
            )
        _audit(conn, "publication.failed", pub, {"error": message, "removing": removing})
    return "failed"


# -- the work ---------------------------------------------------------------------------------


def _long_date(value: date | None) -> str | None:
    return f"{MONTHS[value.month - 1]} {value.day}, {value.year}" if value else None


def cover_text(conn: psycopg.Connection, sermon: dict) -> dict:
    """The same four lines the publish dialog previews."""
    church = conn.execute("SELECT value FROM settings WHERE key = 'church_name'").fetchone()
    primary = Reference.from_json(sermon["primary_passage"])
    return {
        "church": church["value"] if church and isinstance(church["value"], str) else "Your Church",
        "title": sermon["title"] or "Untitled sermon",
        "passage": format_reference(primary) if primary else None,
        "date": _long_date(sermon["recorded_on"]),
    }


class Publisher:
    def __init__(
        self,
        conn: psycopg.Connection,
        config: Config,
        store: ObjectStore,
        channel_factory: Callable[[], tuple[dict, VideoChannel]] | None = None,
    ):
        self.conn, self.config, self.store = conn, config, store
        self.channel_factory = channel_factory or (lambda: load_channel(conn, config))

    def run_once(self) -> bool:
        pub = claim(self.conn, self.config.worker_id)
        if pub is None:
            return False
        try:
            _, channel = self.channel_factory()
            if pub["state"] == "removing":
                self._unpublish(pub, channel)
            else:
                self._publish(pub, channel)
        except Exception as error:  # every failure is recorded; none may kill the worker
            outcome = _fail_attempt(self.conn, pub, error)
            print(
                f"publication {pub['id']} attempt {pub['attempts']}: "
                f"{type(error).__name__}: {error} -> {outcome}",
                flush=True,
            )
        return True

    def _sermon(self, pub: dict) -> dict:
        sermon = self.conn.execute(
            "SELECT * FROM sermons WHERE id = %s", (pub["sermon_id"],)
        ).fetchone()
        if (
            sermon is None
            or sermon["deleted_at"] is not None
            or sermon["status"] not in ("approved", "filing", "filed")
        ):
            raise SermonGone("This sermon can no longer be published.")
        return sermon

    def _publish(self, pub: dict, channel: VideoChannel) -> None:
        sermon = self._sermon(pub)
        pub_id = str(pub["id"])
        if pub["remote_id"]:
            # Already on YouTube (published before, then made private): only change its privacy.
            privacy = channel.set_privacy(pub["remote_id"], pub["visibility"])
            if privacy is None:
                # Someone deleted it on YouTube. Upload it again next time round.
                self.conn.execute(
                    "UPDATE publications SET remote_id = NULL, remote_url = NULL, captions_id = NULL, "
                    "upload_session = NULL, remote_visibility = NULL WHERE id = %s",
                    (pub_id,),
                )
                raise StorageError(
                    "The video was no longer on YouTube, so it will be uploaded again."
                )
            video = UploadedVideo(pub["remote_id"], privacy)
        else:
            video = self._upload(pub, sermon, channel)

        if not pub["captions_id"]:
            self._captions(pub, video.video_id, channel)

        with self.conn.transaction():
            self.conn.execute(
                "UPDATE publications SET state = 'published', locked_by = NULL, remote_visibility = %s, "
                "published_at = now(), first_published_at = COALESCE(first_published_at, now()), "
                "last_error = NULL, error_detail = NULL, updated_at = now() WHERE id = %s",
                (video.privacy, pub_id),
            )
            _audit(
                self.conn, "publication.published", pub,
                {"videoId": video.video_id, "privacy": video.privacy, "asked": pub["visibility"]},
            )  # fmt: skip

    def _upload(self, pub: dict, sermon: dict, channel: VideoChannel) -> UploadedVideo:
        pub_id = str(pub["id"])
        with tempfile.TemporaryDirectory(prefix="sermon-publish-") as tmp:
            video = self._video_file(pub, sermon, Path(tmp))

            def remember(session: str) -> None:
                # The quota is spent when an upload starts, so the daily count starts here too.
                self.conn.execute(
                    "UPDATE publications SET upload_session = %s, "
                    "uploaded_at = COALESCE(uploaded_at, now()) WHERE id = %s",
                    (session, pub_id),
                )

            uploaded = channel.upload_video(
                video,
                VideoMeta(pub["title"], pub["description"], pub["visibility"]),
                pub["upload_session"],
                remember,
                lambda _fraction: _heartbeat(self.conn, pub_id),
            )
        self.conn.execute(
            "UPDATE publications SET remote_id = %s, remote_url = %s, remote_visibility = %s, "
            "upload_session = NULL, uploaded_at = COALESCE(uploaded_at, now()) WHERE id = %s",
            (uploaded.video_id, uploaded.url, uploaded.privacy, pub_id),
        )
        return uploaded

    def _video_file(self, pub: dict, sermon: dict, tmp: Path) -> Path:
        """The rendered video, made once per publication and kept as a new asset for retries."""
        key = f"renders/{pub['sermon_id']}/{pub['id']}.mp4"
        out = tmp / "video.mp4"
        if self.store.exists(key):
            self.store.download(key, out)
            return out
        audio = self.conn.execute(
            "SELECT storage_key FROM audio_assets WHERE sermon_id = %s AND kind = 'cleaned' "
            "AND set_aside_at IS NULL ORDER BY created_at DESC LIMIT 1",
            (pub["sermon_id"],),
        ).fetchone()
        if audio is None:
            raise PermanentError("This sermon has no cleaned recording to publish.")
        source = tmp / f"audio{Path(audio['storage_key']).suffix}"
        self.store.download(audio["storage_key"], source)
        cover = render_cover(tmp / "cover.png", **cover_text(self.conn, sermon))
        pub_id = str(pub["id"])
        render_video(cover, source, out, lambda _f: _heartbeat(self.conn, pub_id))
        self.store.upload(key, out, "video/mp4")
        digest = hashlib.sha256()
        with open(out, "rb") as f:
            while chunk := f.read(1024 * 1024):
                digest.update(chunk)
        self.conn.execute(
            "INSERT INTO audio_assets (sermon_id, kind, storage_key, sha256, bytes, mime, original_filename, "
            "duration_sec) VALUES (%s, 'video_render', %s, %s, %s, 'video/mp4', 'video.mp4', %s) "
            "ON CONFLICT (storage_key) DO NOTHING",
            (pub["sermon_id"], key, digest.hexdigest(), out.stat().st_size, sermon["duration_sec"]),
        )
        return out

    def _captions(self, pub: dict, video_id: str, channel: VideoChannel) -> None:
        transcript = self.conn.execute(
            "SELECT segments FROM transcripts WHERE sermon_id = %s ORDER BY version DESC LIMIT 1",
            (pub["sermon_id"],),
        ).fetchone()
        if transcript is None:
            return
        with tempfile.TemporaryDirectory(prefix="sermon-captions-") as tmp:
            srt = Path(tmp) / "captions.srt"
            srt.write_text(to_srt(transcript["segments"]), encoding="utf-8")
            try:
                captions_id = channel.upload_captions(video_id, srt, "en")
            except VideoRejected as error:
                # The video is up; captions YouTube won't take are noted, not a reason to fail.
                self.conn.execute(
                    "UPDATE publications SET captions_id = 'refused', error_detail = %s WHERE id = %s",
                    (str(error)[:1000], pub["id"]),
                )
                return
        self.conn.execute(
            "UPDATE publications SET captions_id = %s WHERE id = %s", (captions_id, pub["id"])
        )

    def _unpublish(self, pub: dict, channel: VideoChannel) -> None:
        privacy = channel.set_privacy(pub["remote_id"], "private") if pub["remote_id"] else None
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE publications SET state = 'removed', locked_by = NULL, removed_at = now(), "
                "remote_visibility = %s, last_error = NULL, error_detail = NULL, updated_at = now() "
                "WHERE id = %s",
                ("private" if privacy is not None else None, pub["id"]),
            )
            _audit(self.conn, "publication.removed", pub, {"videoGone": privacy is None})


# -- podcast cover art ------------------------------------------------------------------------


def artwork_fingerprint(title: str, church: str) -> str:
    return hashlib.sha256(json.dumps([1, title, church]).encode()).hexdigest()[:16]


def ensure_podcast_artwork(conn: psycopg.Connection, store: ObjectStore) -> bool:
    """Draws the podcast's cover art when the podcast is on and its name has changed since."""
    row = conn.execute(
        "SELECT id, settings, artwork_for FROM distribution_channels WHERE kind = 'podcast' "
        "AND connected_at IS NOT NULL AND disconnected_at IS NULL"
    ).fetchone()
    if row is None:
        return False
    church_row = conn.execute("SELECT value FROM settings WHERE key = 'church_name'").fetchone()
    church = (
        church_row["value"]
        if church_row and isinstance(church_row["value"], str)
        else "Your Church"
    )
    title = (row["settings"] or {}).get("title") or f"{church} Sermons"
    fingerprint = artwork_fingerprint(title, church)
    if row["artwork_for"] == fingerprint:
        return False
    key = f"podcast/artwork-{fingerprint}.png"
    if not store.exists(key):
        with tempfile.TemporaryDirectory(prefix="sermon-artwork-") as tmp:
            out = render_artwork(Path(tmp) / "artwork.png", title=title, church=church)
            store.upload(key, out, "image/png")
    conn.execute(
        "UPDATE distribution_channels SET artwork_key = %s, artwork_for = %s WHERE id = %s",
        (key, fingerprint, row["id"]),
    )
    return True
