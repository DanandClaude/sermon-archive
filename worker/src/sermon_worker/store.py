"""Object storage for the worker. Same key layout as the app's upload store.

Originals are immutable: nothing here will write under `originals/`. Everything the worker makes
is a new object with its own key (the job id is part of it), so a retry never edits old output.
"""

from __future__ import annotations

import os
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path

from .config import Config

PROTECTED_PREFIX = "originals/"


class ProtectedKeyError(Exception):
    pass


class InvalidKeyError(Exception):
    pass


class ObjectNotFound(Exception):
    pass


def check_key(key: str) -> None:
    parts = key.split("/")
    if not key or "\\" in key or any(p in ("", ".", "..") for p in parts):
        raise InvalidKeyError(f"Invalid storage key: {key!r}")


def check_writable(key: str) -> None:
    check_key(key)
    if key.startswith(PROTECTED_PREFIX):
        raise ProtectedKeyError(f"Originals are never overwritten or deleted: {key!r}")


class ObjectStore(ABC):
    @abstractmethod
    def download(self, key: str, dest: Path) -> None: ...

    @abstractmethod
    def upload(self, key: str, src: Path, content_type: str) -> None: ...

    @abstractmethod
    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None: ...

    @abstractmethod
    def exists(self, key: str) -> bool: ...


class LocalStore(ObjectStore):
    """Files under <root>/objects/<key>. Matches the app's development fake."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        check_key(key)
        return self.root / "objects" / key

    def download(self, key: str, dest: Path) -> None:
        src = self._path(key)
        if not src.is_file():
            raise ObjectNotFound(key)
        with open(src, "rb") as fin, open(dest, "wb") as fout:
            while chunk := fin.read(1024 * 1024):
                fout.write(chunk)

    def upload(self, key: str, src: Path, content_type: str) -> None:
        check_writable(key)
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and rename, so a crash never leaves a half-written object.
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".part-")
        try:
            with os.fdopen(fd, "wb") as fout, open(src, "rb") as fin:
                while chunk := fin.read(1024 * 1024):
                    fout.write(chunk)
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        check_writable(key)
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".part-")
        try:
            with os.fdopen(fd, "wb") as fout:
                fout.write(data)
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()


class S3Store(ObjectStore):
    """AWS S3 or an S3-compatible service. Credentials come from the standard AWS variables."""

    def __init__(self, bucket: str, region: str, endpoint: str | None = None, client=None):
        import boto3

        self.bucket = bucket
        self.client = client or boto3.client("s3", region_name=region, endpoint_url=endpoint)

    def download(self, key: str, dest: Path) -> None:
        check_key(key)
        try:
            self.client.download_file(self.bucket, key, str(dest))
        except Exception as error:  # botocore ClientError for a missing key
            if "404" in str(error) or "NoSuchKey" in str(error) or "Not Found" in str(error):
                raise ObjectNotFound(key) from error
            raise

    def upload(self, key: str, src: Path, content_type: str) -> None:
        check_writable(key)
        self.client.upload_file(str(src), self.bucket, key, ExtraArgs={"ContentType": content_type})

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        check_writable(key)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def exists(self, key: str) -> bool:
        check_key(key)
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as error:
            if "404" in str(error) or "Not Found" in str(error):
                return False
            raise


def make_store(config: Config) -> ObjectStore:
    if config.real_mode:
        assert config.s3_bucket and config.s3_region
        return S3Store(config.s3_bucket, config.s3_region, config.s3_endpoint)
    return LocalStore(config.data_dir)
