"""Filing an approved sermon to the shared drive and the admin backup.

Both targets get their files, every file is read back and checked, and only then is the sermon
marked filed. Nothing is overwritten. A file that is already there with the same content is left
alone (so a retry after a partial failure picks up where it stopped); a file that is there with
different content stops the job, because replacing it is never automatic.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import psycopg

from .providers import ObjectExists, StorageError, file_checksum
from .queue import PermanentError
from .render import to_srt, to_text
from .scripture import Reference, format_reference
from .store import ObjectStore
from .targets import LABEL, Target

CONTENT_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aiff": "audio/aiff",
    ".aif": "audio/aiff", ".flac": "audio/flac",
}  # fmt: skip


@dataclass
class FileSpec:
    kind: str
    name: str
    path: Path
    content_type: str


def folder_for(recorded_on: date, stem: str) -> str:
    """1988-03-13 -> 1980s/1988/<stem>."""
    return f"{recorded_on.year // 10 * 10}s/{recorded_on.year}/{stem}"


def _dump(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def _passage(ref: Reference) -> dict:
    return {**ref.as_json(), "text": format_reference(ref)}


def metadata_json(sermon: dict, transcript: dict, refs: list[dict], tags: list[dict]) -> str:
    primary = Reference.from_json(sermon["primary_passage"])
    return _dump(
        {
            "schemaVersion": 1,
            "title": sermon["title"],
            "fileStem": sermon["filename_stem"],
            "recordedOn": sermon["recorded_on"].isoformat(),
            "speaker": sermon["speaker"],
            "summary": sermon["summary_text"],
            "summarySource": sermon["summary_source"],
            "durationSec": sermon["duration_sec"],
            "approvedAt": sermon["approved_at"].isoformat() if sermon["approved_at"] else None,
            "primaryPassage": _passage(primary) if primary else None,
            "tags": [{"kind": t["kind"], "name": t["name"]} for t in tags],
            "passages": [
                {
                    **_passage(
                        Reference(r["book"], r["chapter"], r["verse_start"], r["verse_end"])
                    ),
                    "spokenAtSec": r["spoken_at_sec"],
                    "contextNote": r["context_note"],
                    "isMainText": r["is_main_text"],
                }
                for r in refs
            ],
            "transcript": {
                "model": transcript["model"],
                "language": transcript["language"],
                "version": transcript["version"],
            },
        }
    )


class Filer:
    def __init__(self, conn: psycopg.Connection, store: ObjectStore):
        self.conn, self.store = conn, store

    # -- what to file ---------------------------------------------------------------------------

    def load(self, sermon_id: str) -> dict:
        c = self.conn
        sermon = c.execute("SELECT * FROM sermons WHERE id = %s", (sermon_id,)).fetchone()
        if not sermon or not sermon["filename_stem"] or not sermon["recorded_on"]:
            raise PermanentError(
                "This sermon is missing its file name or date, so it cannot be filed."
            )
        transcript = c.execute(
            "SELECT version, model, language, segments FROM transcripts WHERE sermon_id = %s "
            "ORDER BY version DESC LIMIT 1",
            (sermon_id,),
        ).fetchone()
        if not transcript:
            raise PermanentError("This sermon has no transcript to file.")
        assets = {
            kind: c.execute(
                "SELECT storage_key, mime FROM audio_assets WHERE sermon_id = %s AND kind = %s::audio_kind "
                "ORDER BY created_at DESC LIMIT 1",
                (sermon_id, kind),
            ).fetchone()
            for kind in ("original", "cleaned")
        }
        if not assets["original"] or not assets["cleaned"]:
            raise PermanentError("This sermon is missing its original or cleaned audio.")
        refs = c.execute(
            "SELECT * FROM scripture_refs WHERE sermon_id = %s AND deleted_at IS NULL "
            "ORDER BY spoken_at_sec, created_at",
            (sermon_id,),
        ).fetchall()
        tags = c.execute(
            "SELECT t.kind, t.name FROM sermon_tags st JOIN tags t ON t.id = st.tag_id "
            "WHERE st.sermon_id = %s ORDER BY t.kind, t.name",
            (sermon_id,),
        ).fetchall()
        return {
            "sermon": sermon,
            "transcript": transcript,
            "assets": assets,
            "refs": refs,
            "tags": tags,
        }

    def build(self, ctx: dict, tmp: Path) -> dict[str, list[FileSpec]]:
        """Writes every file to a temp folder and says which go to which target."""
        s, stem = ctx["sermon"], ctx["sermon"]["filename_stem"]
        segments = ctx["transcript"]["segments"]

        def text_file(kind: str, name: str, body: str, content_type: str) -> FileSpec:
            path = tmp / name
            path.write_text(body, encoding="utf-8")
            return FileSpec(kind, name, path, content_type)

        cleaned = tmp / f"{stem}.mp3"
        self.store.download(ctx["assets"]["cleaned"]["storage_key"], cleaned)
        original_key = ctx["assets"]["original"]["storage_key"]
        suffix = Path(original_key).suffix.lower() or ".audio"
        original = tmp / f"{stem}_original{suffix}"
        self.store.download(original_key, original)

        cleaned_spec = FileSpec("audio_cleaned", cleaned.name, cleaned, "audio/mpeg")
        text = text_file(
            "transcript_text", f"{stem}.txt", to_text(segments), "text/plain; charset=utf-8"
        )
        srt = text_file("subtitles", f"{stem}.srt", to_srt(segments), "application/x-subrip")
        meta = text_file(
            "metadata", f"{stem}.json",
            metadata_json(s, ctx["transcript"], ctx["refs"], ctx["tags"]), "application/json",
        )  # fmt: skip
        words = text_file(
            "transcript_json", f"{stem}_transcript.json",
            _dump({k: ctx["transcript"][k] for k in ("model", "language", "version", "segments")}),
            "application/json",
        )  # fmt: skip
        original_spec = FileSpec(
            "audio_original",
            original.name,
            original,
            CONTENT_TYPES.get(suffix, "application/octet-stream"),
        )
        return {
            "shared": [cleaned_spec, text, srt, meta],
            "backup": [original_spec, cleaned_spec, words, text, srt, meta],
        }

    # -- writing one file -----------------------------------------------------------------------

    def file_one(
        self, target: Target, sermon_id: str, folder: str, spec: FileSpec, algorithm: str
    ) -> str:
        """Makes sure this file is in the target and recorded. Returns its path."""
        path = f"{folder}/{spec.name}"
        sha = (
            hashlib.sha256(spec.path.read_bytes()).hexdigest()
            if spec.path.stat().st_size < 64 * 2**20
            else _sha256(spec.path)
        )
        local = file_checksum(spec.path, algorithm)
        known = self.conn.execute(
            "SELECT sha256, state FROM storage_objects WHERE target_id = %s AND path = %s",
            (target.id, path),
        ).fetchone()
        if known and known["state"] in ("uploaded", "verified") and known["sha256"] == sha:
            return path  # filed earlier; the read-back below checks it is still right

        remote = target.provider.stat(path)
        if remote is None:
            try:
                remote = target.provider.put(path, spec.path, spec.content_type)
            except ObjectExists:
                remote = target.provider.stat(path)
        if remote is None or remote.checksum != local:
            if remote is not None and remote.checksum:
                raise PermanentError(
                    f"A different file named {spec.name} is already on the {LABEL[target.role]}. "
                    "Filing stopped so nothing is overwritten."
                )
            raise StorageError(f"The {LABEL[target.role]} did not confirm {spec.name}.")

        self.conn.execute(
            """
            INSERT INTO storage_objects (sermon_id, target_id, kind, path, remote_id, bytes, sha256,
                                         remote_checksum, checksum_algorithm, state, verified_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'uploaded', NULL)
            ON CONFLICT (target_id, path) DO UPDATE
              SET remote_id = EXCLUDED.remote_id, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
                  remote_checksum = EXCLUDED.remote_checksum, state = 'uploaded', verified_at = NULL
            """,
            (sermon_id, target.id, spec.kind, path, remote.remote_id, remote.bytes, sha, remote.checksum, algorithm),
        )  # fmt: skip
        return path

    def read_back(self, targets: dict[str, Target], sermon_id: str) -> None:
        """Checks every recorded file is still there with the checksum it was filed with."""
        rows = self.conn.execute(
            "SELECT o.id, o.path, o.remote_checksum, t.role FROM storage_objects o "
            "JOIN storage_targets t ON t.id = o.target_id WHERE o.sermon_id = %s",
            (sermon_id,),
        ).fetchall()
        for row in rows:
            remote = targets[row["role"]].provider.stat(row["path"])
            if remote is None or remote.checksum != row["remote_checksum"]:
                state = "missing" if remote is None else "drifted"
                self.conn.execute(
                    "UPDATE storage_objects SET state = %s::storage_object_state WHERE id = %s",
                    (state, row["id"]),
                )
                raise StorageError(f"{row['path']} did not check out on the {LABEL[row['role']]}.")
            self.conn.execute(
                "UPDATE storage_objects SET state = 'verified', verified_at = now() WHERE id = %s",
                (row["id"],),
            )

    # -- the whole job --------------------------------------------------------------------------

    def file_sermon(
        self, sermon_id: str, targets: dict[str, Target], progress: Callable[[float], None]
    ) -> int:
        ctx = self.load(sermon_id)
        folder = folder_for(ctx["sermon"]["recorded_on"], ctx["sermon"]["filename_stem"])
        with tempfile.TemporaryDirectory(prefix="sermon-file-") as tmp:
            specs = self.build(ctx, Path(tmp))
            total = sum(len(v) for v in specs.values()) + 1
            done = 0
            for role in ("shared", "backup"):
                target = targets[role]
                for spec in specs[role]:
                    self.file_one(
                        target, sermon_id, folder, spec, target.provider.checksum_algorithm
                    )
                    done += 1
                    progress(done / total)
        self.read_back(targets, sermon_id)
        progress(1.0)
        return sum(len(v) for v in specs.values())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
