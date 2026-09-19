"""Google Drive over its REST API, using only ordinary folders in one account.

The app asks Google for the `drive.file` scope, which lets it see only the files and folders it
created itself: a top folder named "Sermon Archive" (or "... Backup"), and everything inside it.
That works without Google Workspace and cannot touch anything else in the account.

Not exercised against the live service from development, by rule (nothing is filed to a real
account from dev or test). The tests use a stand-in HTTP transport that checks the requests.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import httpx

from .providers import (
    ObjectExists,
    ProviderRejected,
    StorageError,
    StoredObject,
    assert_valid_path,
)

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER = "application/vnd.google-apps.folder"
FIELDS = "id,name,size,md5Checksum"
# Resumable uploads want chunks in multiples of 256 KiB.
UPLOAD_CHUNK = 32 * 256 * 1024


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


class GoogleDriveProvider:
    kind = "google_drive"
    checksum_algorithm = "md5"

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        root_folder_name: str,
        root_folder_id: str | None = None,
        on_root_created: Callable[[str], None] | None = None,
        http: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.client_id, self.client_secret, self.refresh_token = (
            client_id,
            client_secret,
            refresh_token,
        )
        self.root_name, self.root_id = root_folder_name, root_folder_id
        self.on_root_created = on_root_created
        self.http = http or httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0))
        self.clock = clock
        self._token: str | None = None
        self._expires = 0.0
        self._folders: dict[str, str] = {}

    # -- authorisation and requests ------------------------------------------------------------

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
            raise StorageError(f"Could not reach Google to sign in: {error}") from error
        if r.status_code in (400, 401):
            raise ProviderRejected(
                "Google no longer accepts the saved sign-in. Reconnect the account on the "
                "Connections page."
            )
        if r.status_code >= 400:
            raise StorageError(f"Google sign-in failed with status {r.status_code}.")
        data = r.json()
        self._token = data["access_token"]
        self._expires = self.clock() + float(data.get("expires_in", 3600))
        return self._token

    def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in (1, 2):
            headers = {
                **kwargs.pop("headers", {}),
                "Authorization": f"Bearer {self._access_token(attempt == 2)}",
            }
            try:
                r = self.http.request(method, url, headers=headers, **kwargs)
            except httpx.HTTPError as error:
                raise StorageError(f"Could not reach Google Drive: {error}") from error
            if r.status_code == 401 and attempt == 1:
                continue  # the token may have just expired: refresh once and repeat
            if r.status_code == 403 and "storageQuotaExceeded" in r.text:
                raise ProviderRejected("The Google Drive account is out of storage space.")
            if r.status_code in (401, 403):
                raise ProviderRejected(
                    "Google Drive refused access. Reconnect the account on the Connections page."
                )
            if r.status_code == 429 or r.status_code >= 500:
                raise StorageError(f"Google Drive is busy (status {r.status_code}).")
            return r
        raise StorageError("Google Drive sign-in did not work.")  # pragma: no cover

    # -- folders and files ---------------------------------------------------------------------

    def _list(self, parent: str, name: str) -> list[dict]:
        q = f"name = '{_escape(name)}' and '{parent}' in parents and trashed = false"
        r = self._request(
            "GET",
            f"{API}/files",
            params={"q": q, "fields": f"files({FIELDS},mimeType)", "pageSize": 10},
        )
        if r.status_code >= 400:
            raise StorageError(f"Drive could not list files (status {r.status_code}).")
        return r.json().get("files", [])

    def _root(self) -> str:
        if self.root_id:
            return self.root_id
        found = self._list("root", self.root_name)
        folders = [f for f in found if f.get("mimeType") == FOLDER]
        if folders:
            self.root_id = folders[0]["id"]
        else:
            self.root_id = self._make_folder("root", self.root_name)
        if self.on_root_created:
            self.on_root_created(self.root_id)
        return self.root_id

    def _make_folder(self, parent: str, name: str) -> str:
        r = self._request(
            "POST",
            f"{API}/files",
            params={"fields": "id"},
            json={"name": name, "mimeType": FOLDER, "parents": [parent]},
        )
        if r.status_code >= 400:
            raise StorageError(
                f"Drive could not create the folder {name!r} (status {r.status_code})."
            )
        return r.json()["id"]

    def _folder(self, parts: list[str], create: bool) -> str | None:
        current = self._root()
        walked = ""
        for part in parts:
            walked = f"{walked}/{part}"
            if walked in self._folders:
                current = self._folders[walked]
                continue
            match = [f for f in self._list(current, part) if f.get("mimeType") == FOLDER]
            if match:
                current = match[0]["id"]
            elif create:
                current = self._make_folder(current, part)
            else:
                return None
            self._folders[walked] = current
        return current

    @staticmethod
    def _describe(path: str, item: dict) -> StoredObject:
        return StoredObject(item["id"], path, int(item.get("size", 0)), item.get("md5Checksum", ""))

    def stat(self, path: str) -> StoredObject | None:
        assert_valid_path(path)
        *folders, name = path.split("/")
        parent = self._folder(folders, create=False)
        if parent is None:
            return None
        files = [f for f in self._list(parent, name) if f.get("mimeType") != FOLDER]
        return self._describe(path, files[0]) if files else None

    def put(self, path: str, source: Path, content_type: str) -> StoredObject:
        assert_valid_path(path)
        *folders, name = path.split("/")
        parent = self._folder(folders, create=True)
        assert parent is not None
        if [f for f in self._list(parent, name) if f.get("mimeType") != FOLDER]:
            raise ObjectExists(path)
        size = source.stat().st_size
        start = self._request(
            "POST",
            UPLOAD,
            params={"uploadType": "resumable", "fields": FIELDS},
            json={"name": name, "parents": [parent], "mimeType": content_type},
            headers={"X-Upload-Content-Type": content_type, "X-Upload-Content-Length": str(size)},
        )
        if start.status_code >= 400 or "location" not in start.headers:
            raise StorageError(
                f"Drive would not start the upload of {name} (status {start.status_code})."
            )
        session = start.headers["location"]

        def send(offset: int, chunk: bytes) -> httpx.Response:
            end = offset + len(chunk) - 1
            headers = {"Content-Range": f"bytes {offset}-{end}/{size}" if size else "bytes */0"}
            try:
                return self.http.put(session, content=chunk, headers=headers)
            except httpx.HTTPError as error:
                raise StorageError(f"The upload of {name} was interrupted: {error}") from error

        with open(source, "rb") as f:
            offset = 0
            while True:
                chunk = f.read(UPLOAD_CHUNK)
                r = send(offset, chunk)
                if r.status_code in (200, 201):
                    return self._describe(path, r.json())
                if r.status_code != 308 or not chunk:
                    raise StorageError(
                        f"Drive stopped the upload of {name} (status {r.status_code})."
                    )
                offset += len(chunk)
                if offset >= size:
                    raise StorageError(f"Drive did not confirm the upload of {name}.")
