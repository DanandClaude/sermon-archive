"""The sermon status table shared with the app (shared/pipeline.json)."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from .config import REPO_ROOT


def shared_dir() -> Path:
    return Path(os.environ.get("SHARED_DIR", REPO_ROOT / "shared"))


@lru_cache(maxsize=1)
def spec() -> dict:
    return json.loads((shared_dir() / "pipeline.json").read_text())


@lru_cache(maxsize=1)
def bible_books() -> list[str]:
    data = json.loads((shared_dir() / "bible-books.json").read_text())
    return [*data["oldTestament"], *data["newTestament"]]


class InvalidTransition(Exception):
    pass


def can_transition(old: str, new: str) -> bool:
    return new in spec()["transitions"].get(old, [])


def assert_transition(old: str, new: str) -> None:
    if not can_transition(old, new):
        raise InvalidTransition(f"A sermon cannot go from {old!r} to {new!r}.")


def job_config(job_type: str) -> dict:
    try:
        return spec()["jobs"][job_type]
    except KeyError:
        raise KeyError(f"Unknown job type {job_type!r}") from None
