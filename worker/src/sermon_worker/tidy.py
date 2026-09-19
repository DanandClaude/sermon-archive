"""Removes repeated scripture references from sermons analysed before repeats were merged.

    worker/run.sh -m sermon_worker.tidy

A reference is removed when the same passage (or a range that contains it) is already listed
earlier. Only entries the system found and nobody has touched are removed: anything a person added
or corrected stays. Removed entries are hidden, not erased, and the change is recorded in the
audit log.
"""

from __future__ import annotations

import sys

import psycopg
from psycopg.types.json import Jsonb

from . import queue
from .analysis import covers_or_equals
from .config import REPO_ROOT, ConfigError, from_env, load_env_file
from .scripture import Reference


def _ref(row: dict) -> Reference:
    return Reference(row["book"], row["chapter"], row["verse_start"], row["verse_end"])


def dedupe_refs(conn: psycopg.Connection, sermon_id: str) -> int:
    """Hides repeated references on one sermon. Returns how many were hidden."""
    rows = conn.execute(
        "SELECT * FROM scripture_refs WHERE sermon_id = %s AND deleted_at IS NULL "
        "ORDER BY spoken_at_sec, created_at, id",
        (sermon_id,),
    ).fetchall()
    kept: list[dict] = []
    hidden: list[dict] = []
    for row in rows:
        untouched = row["source"] == "auto" and row["edited_at"] is None
        earlier = next((k for k in kept if covers_or_equals(_ref(k), _ref(row))), None)
        if earlier is not None and untouched:
            hidden.append(row)
        else:
            kept.append(row)
    if not hidden:
        return 0
    with conn.transaction():
        conn.execute(
            "UPDATE scripture_refs SET deleted_at = now(), is_main_text = false WHERE id = ANY(%s)",
            ([r["id"] for r in hidden],),
        )
        # The main text is the first live entry that matches the sermon's main passage.
        sermon = conn.execute(
            "SELECT primary_passage FROM sermons WHERE id = %s", (sermon_id,)
        ).fetchone()
        primary = Reference.from_json(sermon["primary_passage"]) if sermon else None
        main = next((k for k in kept if primary and _ref(k) == primary), None)
        conn.execute(
            "UPDATE scripture_refs SET is_main_text = false WHERE sermon_id = %s", (sermon_id,)
        )
        if main:
            conn.execute(
                "UPDATE scripture_refs SET is_main_text = true WHERE id = %s", (main["id"],)
            )
        conn.execute(
            "INSERT INTO audit_log (actor_id, action, entity, entity_id, diff) "
            "VALUES (NULL, 'scripture.dedupe', 'sermon', %s, %s)",
            (sermon_id, Jsonb({"hidden": len(hidden)})),
        )
    return len(hidden)


def dedupe_all(conn: psycopg.Connection) -> dict[str, int]:
    ids = [
        str(r["sermon_id"])
        for r in conn.execute(
            "SELECT DISTINCT r.sermon_id FROM scripture_refs r JOIN sermons s ON s.id = r.sermon_id "
            "WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL"
        ).fetchall()
    ]
    return {i: n for i in ids if (n := dedupe_refs(conn, i))}


def main() -> int:
    load_env_file(REPO_ROOT / ".env.local")
    try:
        config = from_env()
    except ConfigError as error:
        print(f"Configuration problem: {error}", file=sys.stderr)
        return 2
    with queue.connect(config.database_url) as conn:
        result = dedupe_all(conn)
    total = sum(result.values())
    print(f"Hid {total} repeated reference(s) on {len(result)} sermon(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
