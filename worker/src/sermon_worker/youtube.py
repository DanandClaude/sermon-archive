"""YouTube over the Data API v3, and a stand-in channel for development.

The real channel uploads with a resumable session, so a retry after a dropped connection carries on
instead of uploading (and spending quota on) a second copy. Unpublishing makes a video private; this
module has no way to delete one.

Not exercised against the live service from development, by rule (nothing is published to a real
account from dev or test). The tests use a stand-in HTTP transport that checks the requests.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx

from .providers import ProviderRejected, StorageError
from .queue import PermanentError

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3"
# Resumable uploads want chunks in multiples of 256 KiB.
UPLOAD_CHUNK = 32 * 256 * 1024
# "Nonprofits & Activism" is where YouTube files churches and ministries.
CATEGORY_ID = "29"


class PublishError(StorageError):
    """A problem talking to YouTube that trying again may fix."""


class QuotaExceeded(PublishError):
    """The API project's daily quota is spent. Nothing to do until it resets."""


class VideoRejected(PermanentError):
    """YouTube refused the request itself (for example, a title it won't accept)."""


@dataclass(frozen=True)
class VideoMeta:
    title: str
    description: str
    privacy: str  # private, unlisted or public
    language: str = "en"


@dataclass(frozen=True)
class UploadedVideo:
    video_id: str
    privacy: str  # what YouTube reports, which can be private whatever was asked

    @property
    def url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.video_id}"


class VideoChannel(Protocol):
    kind: str

    def upload_video(
        self,
        source: Path,
        meta: VideoMeta,
        session: str | None,
        on_session: Callable[[str], None],
        progress: Callable[[float], None],
    ) -> UploadedVideo:
        """Uploads, or resumes the upload at `session`. Calls `on_session` before sending bytes."""
        ...

    def upload_captions(self, video_id: str, srt: Path, language: str) -> str: ...

    def set_privacy(self, video_id: str, privacy: str) -> str | None:
        """Returns the privacy YouTube now reports, or None if the video no longer exists."""
        ...


# -- the real channel -------------------------------------------------------------------------


class YouTubeChannel:
    kind = "youtube"

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        http: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.client_id, self.client_secret, self.refresh_token = (
            client_id,
            client_secret,
            refresh_token,
        )
        self.http = http or httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))
        self.clock = clock
        self._token: str | None = None
        self._expires = 0.0

    def _access_token(self, force: bool = False) -> str:
        if not force and self._token and self.clock() < self._expires - 60:
            return self._token
        try:
            r = self.http.post(
                TOKEN_URL,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "refresh_token": self.refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        except httpx.HTTPError as error:
            raise PublishError(f"Could not reach Google to sign in: {error}") from error
        if r.status_code in (400, 401):
            raise ProviderRejected(
                "Google no longer accepts the saved YouTube sign-in. Reconnect YouTube on the "
                "Connections page."
            )
        if r.status_code >= 400:
            raise PublishError(f"Google sign-in failed with status {r.status_code}.")
        data = r.json()
        self._token = data["access_token"]
        self._expires = self.clock() + float(data.get("expires_in", 3600))
        return self._token

    @staticmethod
    def _reasons(r: httpx.Response) -> set[str]:
        try:
            errors = r.json().get("error", {}).get("errors", [])
        except ValueError:
            return set()
        return {e.get("reason", "") for e in errors if isinstance(e, dict)}

    def _check(self, r: httpx.Response, doing: str) -> httpx.Response:
        if r.status_code < 400:
            return r
        reasons = self._reasons(r)
        if reasons & {
            "quotaExceeded",
            "dailyLimitExceeded",
            "uploadLimitExceeded",
            "rateLimitExceeded",
        }:
            raise QuotaExceeded(f"YouTube's daily limit was reached while {doing}.")
        if "youtubeSignupRequired" in reasons:
            raise ProviderRejected(
                "The connected Google account has no YouTube channel. Create one, then reconnect."
            )
        if r.status_code in (401, 403):
            raise ProviderRejected(
                f"YouTube refused access while {doing}. Reconnect YouTube on the Connections page."
            )
        if r.status_code == 429 or r.status_code >= 500:
            raise PublishError(f"YouTube is busy (status {r.status_code}) while {doing}.")
        detail = ", ".join(sorted(reasons)) or r.text[:200]
        raise VideoRejected(f"YouTube refused {doing} (status {r.status_code}: {detail}).")

    def _request(self, method: str, url: str, doing: str, **kwargs) -> httpx.Response:
        for attempt in (1, 2):
            headers = {
                **kwargs.pop("headers", {}),
                "Authorization": f"Bearer {self._access_token(attempt == 2)}",
            }
            try:
                r = self.http.request(method, url, headers=headers, **kwargs)
            except httpx.HTTPError as error:
                raise PublishError(f"Could not reach YouTube while {doing}: {error}") from error
            if r.status_code == 401 and attempt == 1:
                continue  # the token may have just expired: refresh once and repeat
            return r
        return r  # pragma: no cover

    # -- videos -------------------------------------------------------------------------------

    def _start_session(self, meta: VideoMeta, size: int) -> str:
        body = {
            "snippet": {
                "title": meta.title,
                "description": meta.description,
                "categoryId": CATEGORY_ID,
                "defaultLanguage": meta.language,
                "defaultAudioLanguage": meta.language,
            },
            "status": {
                "privacyStatus": meta.privacy,
                # Sermons are not "made for kids" under COPPA; YouTube requires the answer.
                "selfDeclaredMadeForKids": False,
                "embeddable": True,
            },
        }
        r = self._check(
            self._request(
                "POST",
                f"{UPLOAD}/videos",
                "starting the upload",
                params={"uploadType": "resumable", "part": "snippet,status"},
                json=body,
                headers={
                    "X-Upload-Content-Type": "video/mp4",
                    "X-Upload-Content-Length": str(size),
                },
            ),
            "starting the upload",
        )
        if "location" not in r.headers:
            raise PublishError("YouTube did not give an upload address.")
        return r.headers["location"]

    def _put(self, session: str, chunk: bytes, content_range: str) -> httpx.Response:
        try:
            return self.http.put(
                session,
                content=chunk,
                headers={
                    "Content-Range": content_range,
                    "Authorization": f"Bearer {self._access_token()}",
                },
            )
        except httpx.HTTPError as error:
            raise PublishError(f"The video upload was interrupted: {error}") from error

    def _resume_offset(self, session: str, size: int) -> int | dict | None:
        """Where an earlier session stopped: a byte offset, the finished video, or None if expired."""
        r = self._put(session, b"", f"bytes */{size}")
        if r.status_code in (200, 201):
            return r.json()
        if r.status_code == 308:
            received = r.headers.get("range")  # "bytes=0-12345"
            return int(received.split("-")[1]) + 1 if received else 0
        if r.status_code in (404, 410):
            return None
        self._check(r, "resuming the upload")
        raise PublishError(
            f"YouTube did not say where the upload stopped (status {r.status_code})."
        )

    def upload_video(self, source, meta, session, on_session, progress) -> UploadedVideo:
        size = source.stat().st_size
        offset: int | dict | None = None
        if session:
            offset = self._resume_offset(session, size)
        if isinstance(offset, dict):
            return self._uploaded(offset)
        if offset is None:
            session = self._start_session(meta, size)
            offset = 0
        assert session is not None
        on_session(session)

        with open(source, "rb") as f:
            f.seek(offset)
            while True:
                chunk = f.read(UPLOAD_CHUNK)
                if not chunk:
                    raise PublishError("YouTube did not confirm the upload.")
                end = offset + len(chunk) - 1
                r = self._put(session, chunk, f"bytes {offset}-{end}/{size}")
                if r.status_code in (200, 201):
                    progress(1.0)
                    return self._uploaded(r.json())
                if r.status_code != 308:
                    self._check(r, "uploading the video")
                    raise PublishError(f"YouTube stopped the upload (status {r.status_code}).")
                received = r.headers.get("range")
                offset = int(received.split("-")[1]) + 1 if received else offset + len(chunk)
                f.seek(offset)
                progress(min(0.99, offset / size))

    @staticmethod
    def _uploaded(data: dict) -> UploadedVideo:
        if not data.get("id"):
            raise PublishError("YouTube did not return the new video's id.")
        privacy = data.get("status", {}).get("privacyStatus", "private")
        return UploadedVideo(data["id"], privacy)

    def upload_captions(self, video_id: str, srt: Path, language: str) -> str:
        boundary = f"sermon-{uuid.uuid4().hex}"
        meta = {
            "snippet": {"videoId": video_id, "language": language, "name": "", "isDraft": False}
        }
        body = (
            (
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                f"{json.dumps(meta)}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + srt.read_bytes()
            + f"\r\n--{boundary}--\r\n".encode()
        )
        r = self._check(
            self._request(
                "POST",
                f"{UPLOAD}/captions",
                "adding the captions",
                params={"uploadType": "multipart", "part": "snippet"},
                content=body,
                headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            ),
            "adding the captions",
        )
        return r.json()["id"]

    def set_privacy(self, video_id: str, privacy: str) -> str | None:
        r = self._request(
            "PUT",
            f"{API}/videos",
            "changing the video's privacy",
            params={"part": "status"},
            json={
                "id": video_id,
                "status": {
                    "privacyStatus": privacy,
                    "selfDeclaredMadeForKids": False,
                    "embeddable": True,
                },
            },
        )
        if r.status_code == 404 or "videoNotFound" in self._reasons(r):
            return None
        self._check(r, "changing the video's privacy")
        return r.json().get("status", {}).get("privacyStatus", privacy)


# -- the development stand-in -----------------------------------------------------------------


class FakeChannel:
    """A folder on this machine standing in for a YouTube channel. Development and tests only."""

    kind = "fake"

    def __init__(self, root: Path):
        self.root = root

    def _video(self, video_id: str) -> Path:
        return self.root / video_id

    def _meta(self, video_id: str) -> dict:
        return json.loads((self._video(video_id) / "video.json").read_text())

    def _save(self, video_id: str, meta: dict) -> None:
        (self._video(video_id) / "video.json").write_text(json.dumps(meta, indent=2) + "\n")

    def upload_video(self, source, meta, session, on_session, progress) -> UploadedVideo:
        if session and (self.root / session).is_dir():
            video_id = session  # the stand-in finishes a "resumed" upload at once
        else:
            video_id = f"fake{uuid.uuid4().hex[:11]}"
            on_session(video_id)
        folder = self._video(video_id)
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, folder / "video.mp4")
        self._save(
            video_id,
            {"title": meta.title, "description": meta.description, "privacy": meta.privacy},
        )
        progress(1.0)
        return UploadedVideo(video_id, meta.privacy)

    def upload_captions(self, video_id: str, srt: Path, language: str) -> str:
        shutil.copyfile(srt, self._video(video_id) / f"captions.{language}.srt")
        return f"{video_id}-captions-{language}"

    def set_privacy(self, video_id: str, privacy: str) -> str | None:
        if not (self._video(video_id) / "video.json").is_file():
            return None
        meta = self._meta(video_id)
        meta["privacy"] = privacy
        self._save(video_id, meta)
        return privacy
