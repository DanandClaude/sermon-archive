"""Where approved sermons are filed. The app's StorageProvider contract, in Python.

Providers are create-only: nothing here overwrites or deletes a file. Each declares which checksum
it reports (Drive gives MD5), and the filing job compares that against the same hash of the local
file and also keeps its own SHA-256.
"""

from __future__ import annotations

import hashlib
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .queue import PermanentError

CHUNK = 1024 * 1024


@dataclass(frozen=True)
class StoredObject:
    remote_id: str
    path: str  # relative to the target's root, slash-separated
    bytes: int
    checksum: str  # as the provider reports it, in the provider's algorithm


class StorageProvider(Protocol):
    kind: str
    checksum_algorithm: str

    def put(self, path: str, source: Path, content_type: str) -> StoredObject:
        """Create-only. Raises ObjectExists if the path is taken."""
        ...

    def stat(self, path: str) -> StoredObject | None: ...


class StorageError(Exception):
    """A storage problem that trying again may fix (a busy service, a dropped connection)."""


class ObjectExists(StorageError):
    pass


class ProviderRejected(PermanentError):
    """Trying again cannot help until an admin fixes the connection."""


class InvalidPath(PermanentError):
    pass


def assert_valid_path(path: str) -> None:
    parts = path.split("/")
    if not path or "\\" in path or any(p in ("", ".", "..") for p in parts):
        raise InvalidPath(f"Invalid storage path: {path!r}")


def file_checksum(path: Path, algorithm: str) -> str:
    """The hash of a local file in the algorithm a provider reports."""
    if algorithm not in ("md5", "sha256", "sha1"):
        raise ProviderRejected(f"This worker cannot compute {algorithm} checksums.")
    digest = hashlib.new(algorithm)
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


class LocalDiskProvider:
    """A folder on this machine. For development and tests only: it is refused in production."""

    kind = "local"
    checksum_algorithm = "md5"

    def __init__(self, root: Path):
        self.root = root

    def _at(self, path: str) -> Path:
        assert_valid_path(path)
        return self.root / path

    def _describe(self, path: str) -> StoredObject:
        target = self._at(path)
        return StoredObject(
            f"local:{path}", path, target.stat().st_size, file_checksum(target, "md5")
        )

    def put(self, path: str, source: Path, content_type: str) -> StoredObject:
        target = self._at(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(target, "xb") as out, open(source, "rb") as src:
                shutil.copyfileobj(src, out, CHUNK)
        except FileExistsError:
            raise ObjectExists(path) from None
        return self._describe(path)

    def stat(self, path: str) -> StoredObject | None:
        return self._describe(path) if self._at(path).is_file() else None


ProviderFactory = Callable[[], StorageProvider]
