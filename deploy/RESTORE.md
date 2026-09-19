# Getting your data back

The nightly backup copies the app's records (people, sermons, transcripts, passage lists, settings and the
history of changes) to your storage bucket under `db-backups/`. It keeps one per day for 14 days and each
Sunday's for 8 weeks. It does **not** contain recordings: those are in your bucket and, once approved, in the
two Google Drives.

If you set a `BACKUP_PASSPHRASE`, backups are encrypted and you need that passphrase, and your `SECRETS_KEY`,
to get everything working again. Keep both outside the server.

All commands are run in the `deploy` folder.

## See what's kept

```bash
docker compose run --rm --no-deps backup python -m sermon_worker.backup list
```

## Restore onto a new or empty server (a disaster)

1. Install Docker and get the files as in INSTALL.md steps 1 and 5. Put your **original** `.env` in place,
   including the same `SECRETS_KEY`, `BACKUP_PASSPHRASE`, bucket settings and `POSTGRES_PASSWORD`.
2. Start only the database:
   ```bash
   docker compose up -d postgres
   ```
3. Restore the newest backup into it (or name one from the list):
   ```bash
   docker compose run --rm --no-deps backup python -m sermon_worker.backup restore latest \
     --into "postgres://sermon:YOUR_POSTGRES_PASSWORD@postgres:5432/sermon_archive"
   ```
   It refuses to restore into a database that already has data, so it can't overwrite anything by accident.
4. Start everything:
   ```bash
   docker compose up -d
   ```
5. Sign in and check the **Connections** page. If you kept the same `SECRETS_KEY` the two Drives are still
   connected; if not, press **Reconnect account** on each.

## Go back to an earlier day (something was changed or deleted by mistake)

Restore into a **separate** database, look at it, and copy what you need back by hand, or, if you want to
replace everything, stop the app first:

```bash
docker compose stop web worker backup
docker compose run --rm --no-deps backup python -m sermon_worker.backup restore \
  db-backups/daily/sermon-archive-2026-09-18.dump.enc \
  --into "postgres://sermon:YOUR_POSTGRES_PASSWORD@postgres:5432/sermon_archive" --overwrite
docker compose up -d
```

`--overwrite` replaces everything in the database with the backup. Anything entered since that day is lost.

## Test it once

A backup you've never restored is a guess. After your first backup exists, restore it into a scratch database
and look inside:

```bash
docker compose exec postgres psql -U sermon -d postgres -c "create database restore_test"
docker compose run --rm --no-deps backup python -m sermon_worker.backup restore latest \
  --into "postgres://sermon:YOUR_POSTGRES_PASSWORD@postgres:5432/restore_test"
docker compose exec postgres psql -U sermon -d restore_test -c "select count(*) from sermons"
docker compose exec postgres psql -U sermon -d postgres -c "drop database restore_test"
```
