"""The two places sermons are filed, read from the database with their credentials decrypted."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import psycopg

from .config import Config
from .drive import GoogleDriveProvider
from .providers import LocalDiskProvider, ProviderRejected, StorageProvider
from .queue import PermanentError
from .secrets_box import SecretsError, decrypt_json, secrets_key

ROLES = ("shared", "backup")
LABEL = {"shared": "shared drive", "backup": "backup"}


@dataclass
class Target:
    id: str
    role: str
    account: str | None
    provider: StorageProvider


def make_provider(conn: psycopg.Connection, config: Config, row: dict) -> StorageProvider:
    try:
        settings = decrypt_json(
            row["encrypted_config"],
            secrets_key(config.secrets_key, config.node_env == "production"),
        )
    except SecretsError as error:
        raise ProviderRejected(
            f"The saved credentials for the {LABEL[row['role']]} could not be read. "
            "Reconnect it on the Connections page."
        ) from error

    if settings.get("kind") == "local":
        if config.node_env == "production":
            raise ProviderRejected("A development folder cannot be used in production.")
        return LocalDiskProvider(Path(settings["path"]))

    if settings.get("kind") == "google_drive":
        if not config.real_mode:
            # Nothing is filed to a real account from development or tests.
            raise ProviderRejected(
                "Google Drive is only used when the app runs in production mode "
                "(ADAPTER_MODE=real)."
            )

        def remember_root(folder_id: str) -> None:
            conn.execute(
                "UPDATE storage_targets SET root_folder_id = %s WHERE id = %s AND root_folder_id IS NULL",
                (folder_id, row["id"]),
            )

        return GoogleDriveProvider(
            client_id=config.google_client_id or "",
            client_secret=config.google_client_secret or "",
            refresh_token=settings["refreshToken"],
            root_folder_name=row["root_folder_name"],
            root_folder_id=row["root_folder_id"],
            on_root_created=remember_root,
        )
    raise ProviderRejected("This storage target uses a provider this worker does not know.")


def load_targets(conn: psycopg.Connection, config: Config, *, need_all: bool) -> dict[str, Target]:
    """Connected targets by role. With `need_all`, both must be connected or the job cannot run."""
    rows = conn.execute(
        "SELECT * FROM storage_targets WHERE encrypted_config IS NOT NULL AND disconnected_at IS NULL"
    ).fetchall()
    found = {r["role"]: r for r in rows}
    if need_all and set(found) != set(ROLES):
        raise PermanentError(
            "Connect the shared drive and the backup on the Connections page, then file this again."
        )
    return {
        role: Target(str(row["id"]), role, row["account_label"], make_provider(conn, config, row))
        for role, row in found.items()
    }
