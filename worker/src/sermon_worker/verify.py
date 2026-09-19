"""Checking that filed sermons are still intact: "Verify now" and the nightly run.

Each recorded file is looked up again in its target. The provider's checksum must match the one
recorded when the file was filed. A file that has changed is `drifted`, one that has gone is
`missing`. Nothing is repaired or replaced automatically; an admin sees the list and decides.
"""

from __future__ import annotations

from datetime import datetime

import psycopg
from psycopg.types.json import Jsonb

from .config import Config
from .targets import LABEL, load_targets

NIGHTLY_HOUR = 3


def claim_run(conn: psycopg.Connection) -> str | None:
    row = conn.execute(
        """
        UPDATE verification_runs SET state = 'running', started_at = now()
        WHERE id = (SELECT id FROM verification_runs WHERE state = 'queued'
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id
        """
    ).fetchone()
    return str(row["id"]) if row else None


def reap_stale_runs(conn: psycopg.Connection, older_than_minutes: int = 120) -> int:
    rows = conn.execute(
        "UPDATE verification_runs SET state = 'failed', finished_at = now(), "
        "error = 'The worker stopped while checking.' "
        "WHERE state = 'running' AND started_at < now() - make_interval(mins => %s) RETURNING id",
        (older_than_minutes,),
    ).fetchall()
    return len(rows)


def ensure_nightly(conn: psycopg.Connection, now: datetime | None = None) -> bool:
    """Queues the nightly check once a day after 3 a.m. local time, if anything has been filed."""
    now = now or datetime.now()
    if now.hour < NIGHTLY_HOUR:
        return False
    row = conn.execute(
        """
        INSERT INTO verification_runs (trigger)
        SELECT 'nightly'
        WHERE EXISTS (SELECT 1 FROM storage_objects)
          AND NOT EXISTS (SELECT 1 FROM verification_runs
                          WHERE trigger = 'nightly' AND created_at > now() - interval '20 hours')
        RETURNING id
        """
    ).fetchone()
    return row is not None


def run_verification(conn: psycopg.Connection, config: Config, run_id: str) -> dict:
    counts = {"checked": 0, "verified": 0, "drifted": 0, "missing": 0}
    problems: list[str] = []
    try:
        targets = load_targets(conn, config, need_all=False)
    except Exception as error:  # a broken saved credential must not stop the run recording that
        return _finish(conn, run_id, counts, [str(error)])

    for role, target in targets.items():
        try:
            rows = conn.execute(
                "SELECT id, path, remote_checksum FROM storage_objects WHERE target_id = %s ORDER BY path",
                (target.id,),
            ).fetchall()
            for row in rows:
                remote = target.provider.stat(row["path"])
                counts["checked"] += 1
                if remote is None:
                    state = "missing"
                elif remote.checksum != row["remote_checksum"]:
                    state = "drifted"
                else:
                    state = "verified"
                counts[state] += 1
                conn.execute(
                    "UPDATE storage_objects SET state = %s::storage_object_state, "
                    "verified_at = CASE WHEN %s = 'verified' THEN now() ELSE verified_at END WHERE id = %s",
                    (state, state, row["id"]),
                )
            conn.execute(
                "UPDATE storage_targets SET last_verified_at = now() WHERE id = %s", (target.id,)
            )
        except Exception as error:  # one target failing must not hide the other's result
            problems.append(f"The {LABEL[role]} could not be checked: {error}"[:300])
    return _finish(conn, run_id, counts, problems)


def _finish(conn: psycopg.Connection, run_id: str, counts: dict, problems: list[str]) -> dict:
    error = " ".join(problems) or None
    with conn.transaction():
        conn.execute(
            "UPDATE verification_runs SET state = %s, finished_at = now(), checked = %s, verified = %s, "
            "drifted = %s, missing = %s, error = %s WHERE id = %s",
            ("failed" if error else "done", counts["checked"], counts["verified"], counts["drifted"],
             counts["missing"], error, run_id),
        )  # fmt: skip
        conn.execute(
            "INSERT INTO audit_log (actor_id, action, entity, entity_id, diff) "
            "VALUES (NULL, 'storage.verified', 'verification_run', %s, %s)",
            (run_id, Jsonb({**counts, "error": error})),
        )
    return {**counts, "error": error}
