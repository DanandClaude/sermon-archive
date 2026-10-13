"""The YouTube channel against a stand-in YouTube service, and the cover images."""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from PIL import Image

from sermon_worker.cover import render_artwork, render_cover
from sermon_worker.providers import ProviderRejected
from sermon_worker.youtube import (
    UPLOAD_CHUNK,
    PublishError,
    QuotaExceeded,
    VideoMeta,
    VideoRejected,
    YouTubeChannel,
)

META = VideoMeta("Submitting to Leaders", "A summary.", "unlisted")


def error(status: int, reason: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"errors": [{"reason": reason}]}})


class FakeYouTube:
    """Just enough of Google's token endpoint and the YouTube Data API for the channel to talk to."""

    def __init__(self):
        self.videos: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self.captions: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.token_calls = 0
        self.revoked = False
        self.fail_with: httpx.Response | None = None
        self.lock_private = False
        self.drop_after_chunks: int | None = None
        self._n = 0

    def _id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = urlparse(str(request.url))
        self.requests.append((request.method, str(request.url)))
        if url.netloc == "oauth2.googleapis.com":
            self.token_calls += 1
            if self.revoked:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(
                200, json={"access_token": f"tok{self.token_calls}", "expires_in": 3600}
            )
        assert request.headers["authorization"].startswith("Bearer tok")
        if self.fail_with is not None:
            return self.fail_with
        if url.path.startswith("/upload-session/"):
            return self._session(request, url.path.rsplit("/", 1)[1])
        query = parse_qs(url.query)
        if url.path == "/upload/youtube/v3/videos" and request.method == "POST":
            assert query == {"uploadType": ["resumable"], "part": ["snippet,status"]}
            meta = json.loads(request.content)
            sid = self._id("session")
            self.sessions[sid] = {
                "meta": meta, "data": b"", "size": int(request.headers["x-upload-content-length"]),
                "chunks": 0,
            }  # fmt: skip
            return httpx.Response(
                200, headers={"Location": f"https://www.googleapis.com/upload-session/{sid}"}
            )
        if url.path == "/upload/youtube/v3/captions" and request.method == "POST":
            assert query == {"uploadType": ["multipart"], "part": ["snippet"]}
            boundary = re.search(r"boundary=(\S+)", request.headers["content-type"]).group(1)
            parts = request.content.split(f"--{boundary}".encode())
            meta = json.loads(parts[1].split(b"\r\n\r\n", 1)[1])
            body = parts[2].split(b"\r\n\r\n", 1)[1].rstrip(b"\r\n")
            self.captions.append({**meta["snippet"], "body": body})
            return httpx.Response(200, json={"id": self._id("cap")})
        if url.path == "/youtube/v3/videos" and request.method == "PUT":
            body = json.loads(request.content)
            video = self.videos.get(body["id"])
            if video is None:
                return error(404, "videoNotFound")
            video["status"] = body["status"]
            return httpx.Response(200, json={"id": body["id"], "status": body["status"]})
        return httpx.Response(404, text=f"unexpected {request.method} {url.path}")

    def _session(self, request: httpx.Request, sid: str) -> httpx.Response:
        s = self.sessions.get(sid)
        if s is None:
            return httpx.Response(404)
        content_range = request.headers["content-range"]
        if content_range == f"bytes */{s['size']}":  # "where did we stop?"
            if len(s["data"]) == s["size"]:
                return httpx.Response(200, json=s["result"])
            headers = {"Range": f"bytes=0-{len(s['data']) - 1}"} if s["data"] else {}
            return httpx.Response(308, headers=headers)
        m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
        assert m and int(m.group(1)) == len(s["data"]), "chunks must arrive in order"
        assert int(m.group(1)) % (256 * 1024) == 0
        if self.drop_after_chunks is not None and s["chunks"] >= self.drop_after_chunks:
            raise httpx.ConnectError("connection dropped")
        s["data"] += request.content
        s["chunks"] += 1
        if len(s["data"]) < s["size"]:
            return httpx.Response(308, headers={"Range": f"bytes=0-{len(s['data']) - 1}"})
        vid = self._id("vid")
        privacy = "private" if self.lock_private else s["meta"]["status"]["privacyStatus"]
        self.videos[vid] = {**s["meta"], "data": s["data"], "status": {"privacyStatus": privacy}}
        s["result"] = {"id": vid, "status": {"privacyStatus": privacy, "uploadStatus": "uploaded"}}
        return httpx.Response(201, json=s["result"])


def channel(api: FakeYouTube) -> YouTubeChannel:
    return YouTubeChannel(
        client_id="cid", client_secret="sec", refresh_token="refresh",
        http=httpx.Client(transport=httpx.MockTransport(api)),
    )  # fmt: skip


@pytest.fixture()
def video(tmp_path):
    f = tmp_path / "video.mp4"
    f.write_bytes(b"v" * (UPLOAD_CHUNK * 2 + 1234))
    return f


def upload(yt: YouTubeChannel, video, session=None, sessions=None):
    sessions = sessions if sessions is not None else []
    return yt.upload_video(video, META, session, sessions.append, lambda _f: None)


class TestUpload:
    def test_uploads_in_order_with_the_details_and_no_kids_flag(self, video):
        api = FakeYouTube()
        sessions: list[str] = []
        result = upload(channel(api), video, sessions=sessions)
        stored = api.videos[result.video_id]
        assert stored["data"] == video.read_bytes()
        assert stored["snippet"]["title"] == "Submitting to Leaders"
        assert stored["snippet"]["description"] == "A summary."
        assert stored["status"] == {"privacyStatus": "unlisted"}
        assert api.sessions["session1"]["meta"]["status"]["selfDeclaredMadeForKids"] is False
        assert result.privacy == "unlisted" and result.url.endswith(f"v={result.video_id}")
        assert sessions == ["https://www.googleapis.com/upload-session/session1"]

    def test_reports_when_youtube_locks_the_video_private(self, video):
        api = FakeYouTube()
        api.lock_private = True
        assert upload(channel(api), video).privacy == "private"

    def test_resumes_a_dropped_upload_without_starting_again(self, video):
        api = FakeYouTube()
        api.drop_after_chunks = 1
        sessions: list[str] = []
        with pytest.raises(PublishError):
            upload(channel(api), video, sessions=sessions)
        api.drop_after_chunks = None
        result = upload(channel(api), video, session=sessions[0])
        assert len(api.sessions) == 1  # no second session, so no second video or quota
        assert api.videos[result.video_id]["data"] == video.read_bytes()

    def test_a_finished_session_returns_the_video_instead_of_uploading_again(self, video):
        api = FakeYouTube()
        sessions: list[str] = []
        first = upload(channel(api), video, sessions=sessions)
        again = upload(channel(api), video, session=sessions[0])
        assert again.video_id == first.video_id and len(api.videos) == 1

    def test_an_expired_session_starts_a_new_one(self, video):
        api = FakeYouTube()
        sessions: list[str] = []
        upload(
            channel(api),
            video,
            session="https://www.googleapis.com/upload-session/old",
            sessions=sessions,
        )
        assert sessions == ["https://www.googleapis.com/upload-session/session1"]

    def test_a_spent_quota_is_its_own_error(self, video):
        api = FakeYouTube()
        api.fail_with = error(403, "quotaExceeded")
        with pytest.raises(QuotaExceeded):
            upload(channel(api), video)

    def test_an_account_without_a_channel_is_explained(self, video):
        api = FakeYouTube()
        api.fail_with = error(401, "youtubeSignupRequired")
        with pytest.raises(ProviderRejected, match="no YouTube channel"):
            upload(channel(api), video)

    def test_a_revoked_sign_in_asks_for_a_reconnect(self, video):
        api = FakeYouTube()
        api.revoked = True
        with pytest.raises(ProviderRejected, match="Reconnect YouTube"):
            upload(channel(api), video)

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_a_busy_youtube_is_left_to_the_retry(self, video, status):
        api = FakeYouTube()
        api.fail_with = httpx.Response(status, text="busy")
        with pytest.raises(PublishError):
            upload(channel(api), video)

    def test_a_request_youtube_refuses_is_permanent(self, video):
        api = FakeYouTube()
        api.fail_with = error(400, "invalidTitle")
        with pytest.raises(VideoRejected, match="invalidTitle"):
            upload(channel(api), video)

    def test_never_sends_credentials_in_a_url(self, video):
        api = FakeYouTube()
        upload(channel(api), video)
        queries = [urlparse(url).query for _, url in api.requests]
        assert not any(word in q for q in queries for word in ("refresh", "token", "secret"))


class TestCaptionsAndPrivacy:
    def test_uploads_captions_for_the_video(self, video, tmp_path):
        api = FakeYouTube()
        yt = channel(api)
        vid = upload(yt, video).video_id
        srt = tmp_path / "c.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nTurn with me.\n")
        assert yt.upload_captions(vid, srt, "en").startswith("cap")
        assert api.captions[0]["videoId"] == vid and api.captions[0]["language"] == "en"
        assert api.captions[0]["body"] == srt.read_bytes().rstrip(b"\n")

    def test_changes_privacy_and_says_when_the_video_is_gone(self, video):
        api = FakeYouTube()
        yt = channel(api)
        vid = upload(yt, video).video_id
        assert yt.set_privacy(vid, "private") == "private"
        assert api.videos[vid]["status"]["privacyStatus"] == "private"
        assert yt.set_privacy("missing", "private") is None


class TestCovers:
    def test_cover_is_a_720p_png_with_long_titles_cut_to_fit(self, tmp_path):
        out = render_cover(
            tmp_path / "c.png", church="Grace Church", title="Word " * 80,
            passage="Hebrews 13:17", date="March 13, 1988",
        )  # fmt: skip
        with Image.open(out) as image:
            assert image.size == (1280, 720) and image.format == "PNG"

    def test_cover_without_passage_or_date(self, tmp_path):
        out = render_cover(tmp_path / "c.png", church="C", title="Faith", passage=None, date=None)
        assert out.stat().st_size > 0

    def test_artwork_is_the_square_apple_asks_for(self, tmp_path):
        with Image.open(
            render_artwork(tmp_path / "a.png", title="Grace Sermons", church="Grace")
        ) as image:
            assert image.size == (3000, 3000)
