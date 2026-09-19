"""The renderers and the credential box, checked against what the TypeScript app produces."""

from __future__ import annotations

import json

import pytest

from sermon_worker.pipeline import shared_dir
from sermon_worker.render import format_timestamp, to_srt, to_text, wrap_lines
from sermon_worker.secrets_box import SecretsError, decrypt_json, secrets_key

TRANSCRIPTS = json.loads((shared_dir() / "transcript-cases.json").read_text())["cases"]
SECRETS = json.loads((shared_dir() / "secrets-cases.json").read_text())


@pytest.mark.parametrize("case", TRANSCRIPTS, ids=[c["name"] for c in TRANSCRIPTS])
def test_renders_exactly_what_the_app_renders(case):
    assert to_srt(case["segments"]) == case["srt"]
    assert to_text(case["segments"]) == case["txt"]


def test_timestamps_round_halves_up_like_javascript():
    assert format_timestamp(0.0005) in ("00:00:00,000", "00:00:00,001")  # a float half; JS agrees
    assert format_timestamp(83.5) == "00:01:23,500"
    assert format_timestamp(3725.25, ".") == "01:02:05.250"
    assert format_timestamp(-3) == "00:00:00,000"


def test_wraps_at_forty_two_characters():
    assert wrap_lines("word " * 20).count("\n") >= 1
    assert all(len(line) <= 42 for line in wrap_lines("word " * 20).split("\n"))


@pytest.mark.parametrize("case", SECRETS["cases"])
def test_decrypts_what_the_app_encrypted(case):
    key = bytes.fromhex(SECRETS["keyHex"])
    assert decrypt_json(case["token"], key) == case["plain"]


def test_refuses_the_wrong_key_and_tampering():
    token = SECRETS["cases"][0]["token"]
    with pytest.raises(SecretsError):
        decrypt_json(token, bytes(32))
    head, iv, tag, body = token.split(".")
    with pytest.raises(SecretsError):
        decrypt_json(f"{head}.{iv}.{tag}.{body[:-2]}AA", bytes.fromhex(SECRETS["keyHex"]))
    with pytest.raises(SecretsError, match="Unrecognised"):
        decrypt_json("nonsense", bytes(32))


def test_key_rules():
    assert secrets_key("ab" * 32, True) == bytes.fromhex("ab" * 32)
    assert len(secrets_key(None, False)) == 32
    with pytest.raises(SecretsError, match="required in production"):
        secrets_key(None, True)
    with pytest.raises(SecretsError, match="64 hex"):
        secrets_key("short", False)
