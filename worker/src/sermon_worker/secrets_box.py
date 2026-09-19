"""Decrypts the storage credentials the app saved (src/lib/secrets.ts).

AES-256-GCM, formatted `v1.<iv>.<tag>.<ciphertext>` with base64url parts.
"""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Development and tests only. It matches the app's fallback so both sides agree without setup.
_DEV_KEY_SEED = "sermon-archive-development-only-secrets-key"


class SecretsError(Exception):
    pass


def secrets_key(hex_key: str | None, production: bool) -> bytes:
    if hex_key:
        if len(hex_key) != 64:
            raise SecretsError("SECRETS_KEY must be 64 hex characters (openssl rand -hex 32).")
        return bytes.fromhex(hex_key)
    if production:
        raise SecretsError("SECRETS_KEY is required in production.")
    return hashlib.sha256(_DEV_KEY_SEED.encode()).digest()


def _b64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def decrypt_json(token: str, key: bytes) -> dict:
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        raise SecretsError("Unrecognised encrypted value.")
    _, iv, tag, body = parts
    try:
        plain = AESGCM(key).decrypt(_b64(iv), _b64(body) + _b64(tag), None)
    except Exception as error:  # wrong key, or the value was changed
        raise SecretsError("The saved credentials could not be decrypted.") from error
    return json.loads(plain)
