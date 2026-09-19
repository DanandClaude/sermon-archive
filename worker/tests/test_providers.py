"""The local-disk provider, and the Google Drive provider against a stand-in Drive service."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from sermon_worker.drive import GoogleDriveProvider
from sermon_worker.providers import (
    InvalidPath,
    LocalDiskProvider,
    ObjectExists,
    ProviderRejected,
    StorageError,
    file_checksum,
)


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


class TestLocalDisk:
    def test_puts_and_reports_a_real_checksum(self, tmp_path):
        src = tmp_path / "a.txt"
        src.write_bytes(b"hello")
        provider = LocalDiskProvider(tmp_path / "root")
        stored = provider.put("1980s/1988/x/a.txt", src, "text/plain")
        assert (stored.path, stored.bytes, stored.checksum) == (
            "1980s/1988/x/a.txt",
            5,
            md5(b"hello"),
        )
        assert (tmp_path / "root/1980s/1988/x/a.txt").read_bytes() == b"hello"
        assert provider.stat("1980s/1988/x/a.txt") == stored

    def test_never_overwrites(self, tmp_path):
        src = tmp_path / "a.txt"
        src.write_bytes(b"first")
        provider = LocalDiskProvider(tmp_path / "root")
        provider.put("a.txt", src, "text/plain")
        src.write_bytes(b"second")
        with pytest.raises(ObjectExists):
            provider.put("a.txt", src, "text/plain")
        assert (tmp_path / "root/a.txt").read_bytes() == b"first"

    def test_stat_sees_a_file_changed_behind_its_back(self, tmp_path):
        src = tmp_path / "a.txt"
        src.write_bytes(b"first")
        provider = LocalDiskProvider(tmp_path / "root")
        stored = provider.put("a.txt", src, "text/plain")
        (tmp_path / "root/a.txt").write_bytes(b"changed")
        assert provider.stat("a.txt").checksum != stored.checksum
        (tmp_path / "root/a.txt").unlink()
        assert provider.stat("a.txt") is None

    @pytest.mark.parametrize("path", ["", "/abs", "a//b", "a/../b", "./a", "a\\b", "a/"])
    def test_rejects_paths_that_could_escape(self, tmp_path, path):
        with pytest.raises(InvalidPath):
            LocalDiskProvider(tmp_path).stat(path)

    def test_checksums_in_the_algorithm_asked_for(self, tmp_path):
        f = tmp_path / "a"
        f.write_bytes(b"abc")
        assert file_checksum(f, "md5") == md5(b"abc")
        assert file_checksum(f, "sha256") == hashlib.sha256(b"abc").hexdigest()
        with pytest.raises(ProviderRejected):
            file_checksum(f, "quickxor")


class FakeDrive:
    """Just enough of Google's token endpoint and Drive v3 for the provider to talk to."""

    def __init__(self):
        self.files: dict[str, dict] = {}  # id -> {name, parents, mimeType, data}
        self.sessions: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.token_calls = 0
        self.revoked = False
        self.expire_next_access_token = False
        self.fail_with: int | None = None
        self.quota_full = False
        self._n = 0

    def _id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = urlparse(str(request.url))
        self.requests.append((request.method, url.path))
        if url.netloc == "oauth2.googleapis.com":
            self.token_calls += 1
            body = parse_qs(request.content.decode())
            assert body["grant_type"] == ["refresh_token"]
            if self.revoked:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(
                200, json={"access_token": f"tok{self.token_calls}", "expires_in": 3600}
            )
        if self.fail_with and url.path.startswith(("/drive", "/upload")):
            return httpx.Response(self.fail_with, text="oops")
        if url.path.startswith("/upload-session/"):
            return self._session(request, url.path.rsplit("/", 1)[1])
        assert request.headers["authorization"].startswith("Bearer tok")
        if self.expire_next_access_token:
            self.expire_next_access_token = False
            return httpx.Response(401, text="expired")
        query = parse_qs(url.query)
        if url.path == "/drive/v3/files" and request.method == "GET":
            return self._list(query["q"][0])
        if url.path == "/drive/v3/files" and request.method == "POST":
            meta = json.loads(request.content)
            fid = self._id("folder")
            self.files[fid] = {**meta, "data": None}
            return httpx.Response(200, json={"id": fid})
        if url.path == "/upload/drive/v3/files" and request.method == "POST":
            if self.quota_full:
                return httpx.Response(
                    403, text='{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}'
                )
            assert query["uploadType"] == ["resumable"]
            sid = self._id("session")
            self.sessions[sid] = {
                "meta": json.loads(request.content),
                "data": b"",
                "size": int(request.headers["x-upload-content-length"]),
            }
            return httpx.Response(
                200, headers={"Location": f"https://www.googleapis.com/upload-session/{sid}"}
            )
        return httpx.Response(404, text=f"unexpected {request.method} {url.path}")

    def _list(self, q: str) -> httpx.Response:
        m = re.fullmatch(
            r"name = '((?:[^'\\]|\\.)*)' and '([^']+)' in parents and trashed = false", q
        )
        assert m, q
        name = m.group(1).replace("\\'", "'").replace("\\\\", "\\")
        found = [
            {
                "id": fid,
                "name": f["name"],
                "mimeType": f["mimeType"],
                **(
                    {"size": str(len(f["data"])), "md5Checksum": md5(f["data"])}
                    if f["data"] is not None
                    else {}
                ),
            }
            for fid, f in self.files.items()
            if f["name"] == name and m.group(2) in f["parents"]
        ]
        return httpx.Response(200, json={"files": found})

    def _session(self, request: httpx.Request, sid: str) -> httpx.Response:
        s = self.sessions[sid]
        m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)|bytes \*/0", request.headers["content-range"])
        assert m
        if m.group(1) is not None:
            assert int(m.group(1)) == len(s["data"]), "chunks must arrive in order"
            assert (int(m.group(1)) % (256 * 1024)) == 0
            s["data"] += request.content
        if len(s["data"]) < s["size"]:
            return httpx.Response(308)
        fid = self._id("file")
        self.files[fid] = {**s["meta"], "data": s["data"]}
        return httpx.Response(
            200,
            json={
                "id": fid,
                "name": s["meta"]["name"],
                "size": str(len(s["data"])),
                "md5Checksum": md5(s["data"]),
            },
        )


def provider(drive: FakeDrive, **kw) -> GoogleDriveProvider:
    return GoogleDriveProvider(
        client_id="cid", client_secret="sec", refresh_token="refresh", root_folder_name="Sermon Archive",
        http=httpx.Client(transport=httpx.MockTransport(drive)), **kw,
    )  # fmt: skip


@pytest.fixture()
def src(tmp_path):
    f = tmp_path / "a.mp3"
    f.write_bytes(b"audio-bytes" * 1000)
    return f


class TestGoogleDrive:
    def test_creates_the_folders_and_uploads_a_file_with_its_md5(self, src):
        drive = FakeDrive()
        made: list[str] = []
        p = provider(drive, on_root_created=made.append)
        stored = p.put("1980s/1988/x_y_z/x_y_z.mp3", src, "audio/mpeg")
        assert stored.checksum == md5(src.read_bytes()) and stored.bytes == src.stat().st_size
        names = sorted(f["name"] for f in drive.files.values())
        assert names == ["1980s", "1988", "Sermon Archive", "x_y_z", "x_y_z.mp3"]
        assert made == [next(i for i, f in drive.files.items() if f["name"] == "Sermon Archive")]
        root = next(i for i, f in drive.files.items() if f["name"] == "Sermon Archive")
        assert drive.files[root]["parents"] == ["root"]

    def test_uses_a_saved_root_and_reuses_folders(self, src):
        drive = FakeDrive()
        first = provider(drive)
        first.put("1980s/1988/a/a.mp3", src, "audio/mpeg")
        root = next(i for i, f in drive.files.items() if f["name"] == "Sermon Archive")
        second = provider(drive, root_folder_id=root)
        second.put("1980s/1988/b/b.mp3", src, "audio/mpeg")
        assert (
            sum(1 for f in drive.files.values() if f["name"] in ("1980s", "1988", "Sermon Archive"))
            == 3
        )

    def test_finds_an_existing_root_by_name_instead_of_making_another(self, src):
        drive = FakeDrive()
        provider(drive).put("a.mp3", src, "audio/mpeg")
        again = provider(drive)
        again.put("b.mp3", src, "audio/mpeg")
        assert sum(1 for f in drive.files.values() if f["name"] == "Sermon Archive") == 1

    def test_never_overwrites_and_stat_sees_what_is_there(self, src):
        drive = FakeDrive()
        p = provider(drive)
        p.put("1980s/a.mp3", src, "audio/mpeg")
        with pytest.raises(ObjectExists):
            p.put("1980s/a.mp3", src, "audio/mpeg")
        assert p.stat("1980s/a.mp3").checksum == md5(src.read_bytes())
        assert p.stat("1980s/nope.mp3") is None
        assert p.stat("1990s/a.mp3") is None
        assert sum(1 for f in drive.files.values() if f["name"] == "a.mp3") == 1

    def test_stat_reports_a_file_changed_in_drive(self, src):
        drive = FakeDrive()
        p = provider(drive)
        stored = p.put("a.mp3", src, "audio/mpeg")
        next(f for f in drive.files.values() if f["name"] == "a.mp3")["data"] = (
            b"someone edited this"
        )
        assert p.stat("a.mp3").checksum != stored.checksum

    def test_uploads_big_files_in_order_in_256k_multiples(self, tmp_path):
        big = tmp_path / "big.wav"
        big.write_bytes(bytes(range(256)) * 130_000)  # about 33 MB: several chunks
        drive = FakeDrive()
        stored = provider(drive).put("big.wav", big, "audio/wav")
        assert stored.bytes == big.stat().st_size and stored.checksum == md5(big.read_bytes())
        assert sum(1 for m, p in drive.requests if p.startswith("/upload-session/")) >= 2

    def test_uploads_an_empty_file(self, tmp_path):
        empty = tmp_path / "e.txt"
        empty.write_bytes(b"")
        stored = provider(FakeDrive()).put("e.txt", empty, "text/plain")
        assert stored.bytes == 0

    def test_escapes_quotes_in_names(self, tmp_path):
        f = tmp_path / "x"
        f.write_bytes(b"1")
        drive = FakeDrive()
        p = provider(drive)
        p.put("It's a test/it's.txt", f, "text/plain")
        assert p.stat("It's a test/it's.txt") is not None

    def test_reuses_its_access_token_and_refreshes_an_expired_one(self, src):
        drive = FakeDrive()
        p = provider(drive)
        p.put("a.mp3", src, "audio/mpeg")
        p.stat("a.mp3")
        assert drive.token_calls == 1
        drive.expire_next_access_token = True
        p.stat("a.mp3")
        assert drive.token_calls == 2

    def test_a_revoked_sign_in_asks_the_admin_to_reconnect(self, src):
        drive = FakeDrive()
        drive.revoked = True
        with pytest.raises(ProviderRejected, match="Reconnect"):
            provider(drive).put("a.mp3", src, "audio/mpeg")

    def test_a_full_drive_is_explained(self, src):
        drive = FakeDrive()
        drive.quota_full = True
        with pytest.raises(ProviderRejected, match="out of storage"):
            provider(drive).put("a.mp3", src, "audio/mpeg")

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_a_busy_drive_is_left_to_the_jobs_retry(self, src, status):
        drive = FakeDrive()
        drive.fail_with = status
        with pytest.raises(StorageError) as caught:
            provider(drive).put("a.mp3", src, "audio/mpeg")
        assert not isinstance(caught.value, ProviderRejected)

    def test_a_dropped_connection_is_a_retryable_error(self, src):
        def boom(request):
            if request.url.host == "oauth2.googleapis.com":
                return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
            raise httpx.ConnectError("no route")

        p = GoogleDriveProvider(client_id="c", client_secret="s", refresh_token="r", root_folder_name="X", root_folder_id="root1", http=httpx.Client(transport=httpx.MockTransport(boom)))  # fmt: skip
        with pytest.raises(StorageError, match="Could not reach"):
            p.put("a.mp3", src, "audio/mpeg")

    def test_never_sends_credentials_in_a_url(self, src):
        drive = FakeDrive()
        provider(drive).put("a.mp3", src, "audio/mpeg")
        assert all("refresh" not in path for _, path in drive.requests)
