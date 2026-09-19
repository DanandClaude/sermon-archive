# Sermon Archive (web) — project guide

Read this first, then `SPEC.md` (full product + technical spec) and skim `design/` (UI mockup source).

## What we're building
A web app where designated people at different locations upload digitized cassette-tape sermons (1980s–90s). The app cleans up the audio, transcribes it, names and categorizes it, writes a short summary, lists the Bible passages the pastor names out loud (with timestamps), and files everything to a shared drive plus an admin-only backup. Admins can connect YouTube and/or a podcast feed to publish approved sermons.

This is **v2** of an existing offline Mac desktop app (Whisper-based cleanup + transcription). Reuse its ideas, not its code, unless the owner points you at it.

## Working agreements
- Build in the phases listed in `SPEC.md` §14. Before each phase, post a short plan (files, schema changes, risks) and wait for a go-ahead.
- `SPEC.md` §15 lists **open decisions**. Do not silently pick an answer for those. Propose a default, say why, and ask.
- Originals are immutable. Never overwrite or delete an uploaded original; all processing writes new assets.
- Nothing is ever published or filed to a real external account from dev or test. Use fake adapters (Drive, YouTube, podcast) behind interfaces; real credentials only via env vars in a non-dev environment.
- Never commit secrets. OAuth tokens are encrypted at rest.
- Permissions are enforced on the server for every route and job, not just hidden in the UI.
- Write tests as you go, especially for: filename generation, scripture parsing/validation, the job state machine, and permission checks.
- Keep commits small and messages plain. Update this file's **Commands** section as soon as the scaffold exists.

## Non-negotiables (from the owner)
- File naming: `YYYY-MM-DD_Book-Chapter-Verse_ShortTitle` (e.g. `1988-03-13_Hebrews-13-17_Submitting-to-Leaders`).
- Scripture list contains only passages the pastor **names aloud**. Reviewers can add, edit and delete entries.
- Only admins can publish, connect distribution channels, or open the backup vault.
- Contributors upload, review and approve their own sermons (open decision D1 may change this).
- UI should be sleek and simple; the mockup in `design/` is the visual target.

## Domain notes
- Audio is mostly a single speaker with a Southern American English accent, recorded on consumer cassette gear: expect hiss, hum, level swings, occasional dropouts. Sides A and B of one tape arrive as separate files.
- Tape labels usually give a date and a Bible passage. Trust label data the contributor types over anything detected.
- Bible text in samples is KJV (public domain). Use KJV-style book names and the standard 66-book Protestant canon for validation.

## Design tokens (also in `SPEC.md` §16)
Ground `#F6F3EC`, surface `#FFFFFF`, ink `#1E1D1A`, muted `#5E584E`, line `#E5DFD3`, accent spruce `#1F5C52` (tint `#E3EFEB`), sidebar `#14201D`, amber `#E19A1F` (tint `#FBEFD9`, text `#8A5200`), danger `#A23B2A`.
Fonts: Fraunces (headings), Instrument Sans (UI), IBM Plex Mono (file names, timestamps). Touch targets ≥ 44px.

## Commands
Needs Node 24 (`.nvmrc`) and local Postgres 16. No Docker or Redis.

- First-time setup: `npm install`, `createdb sermon_archive && createdb sermon_archive_test`, `cp .env.example .env.local` (set `APP_URL` to the port you run on), `npm run db:migrate`
- First admin: `npm run admin:create -- --email you@example.org --name "Your Name"` prints a one-time sign-in link
- Dev server: `npm run dev`. Sign-in emails are not sent in development; open `/dev/outbox` to click the link
- Tests: `npm test` (rebuilds `sermon_archive_test` from the migrations and refuses any database not named `*_test`); `npm run test:watch`
- Checks: `npm run lint`, `npm run typecheck`, `npm run format:check`; CI runs these plus `npm run build`
- Migrations: edit `src/db/schema.ts`, run `npm run db:generate`, commit `drizzle/`, then `npm run db:migrate`
- Worker (Python, `worker/`): `npm run worker:install` once, then `npm run worker` (or `npm run worker:once`); `npm run worker:test`, `npm run worker:lint`. See `worker/README.md`. It never downloads a model by itself: `worker/run.sh -m sermon_worker.fetch_model large-v3`
- On an Apple Silicon Mac use `TRANSCRIBER=mlx` (about 4x faster than CPU on real tapes; `npm run worker:install-mlx`). Without any model, `TRANSCRIBER=fake` runs the whole pipeline with canned text (development only)

## Conventions
- Next.js 16: `middleware` is now `proxy`, and some APIs differ from older versions. Read `node_modules/next/dist/docs/` before using one.
- Permissions: the role matrix and sermon rules live in `src/lib/permissions.ts`. Every page and server action calls `requireCapability()` (`src/lib/auth/guard.ts`); every API route calls `authenticateApi()` (`src/lib/auth/api.ts`). Never rely on a layout, the proxy, or a hidden link.
- Visibility: viewers see approved sermons only, contributors their own drafts plus approved, admins all. It is enforced in SQL (`visibleSermons` in `src/lib/sermons/visibility.ts`); a test keeps it in step with `canViewSermon`. Always query sermons through it.
- Sign-in: magic link only, invite-only. Links and sessions are stored as hashes (`src/lib/auth/`). Opening an emailed link only shows a confirm page; the button spends it.
- People: admins add users at `/admin/team`. Disabling removes someone (their sessions end at once). There must always be an active admin.
- Church and speaker names are rows in `settings` (`src/lib/settings.ts`), edited at `/admin/settings`. Never hardcode either.
- Sermon status changes go through `transitionSermon` and the table in `src/lib/sermon-status.ts`.
- Uploads: the browser sends parts straight to storage using presigned URLs (`src/lib/uploads/`). Uploaded originals are never overwritten or deleted.
- External services go through `src/adapters/` (mail, upload storage, Drive, YouTube, podcast). Development and tests get in-memory or local-disk fakes (`.data/` is git-ignored); `ADAPTER_MODE=real` throws outside production.
- Processing: the app enqueues rows in `jobs`; the Python worker claims them (`FOR UPDATE SKIP LOCKED`), cleans and transcribes, and writes new assets. The sermon status table is shared: `shared/pipeline.json` is read by both sides and a test fails if it differs from `src/lib/sermon-status.ts`. Change it in both places.
- Transcripts live in `transcripts` (word-timed, versioned). SRT, VTT and text are rendered on demand by `src/lib/transcripts/render.ts`; don't store them.
- Failures are shown to contributors in plain language (`sermons.last_error`); raw error text stays in `jobs` and is visible to admins only.
- Transcription is in-house (MLX on the Mac's GPU, or faster-whisper on a CPU). Don't add a hosted transcription service; the owner chose not to send audio to third parties. Tuning is done on real tapes in `fixtures/private/` (git-ignored, never commit sermon audio): the worker transcribes the original audio by default and cleans conservatively, because on real tapes cleanup did not help transcription.
- The owner is fine with the Anthropic API reading transcript text (titles, summaries, scripture). Audio never goes to a third party. The worker's `ANALYZER` is `fake` in development and tests (real only when set, and required in production); never put a real key in a test or fixture.
- Scripture: `shared/canon.json` (from public-domain KJV via `scripts/build-canon.ts`) and `shared/book-aliases.json` are read by both `src/lib/scripture/canon.ts` and `worker/src/sermon_worker/scripture.py`; `shared/reference-cases.json` is tested by both. Change a rule in both places.
- Filing: approval queues a `file` job (`worker/src/sermon_worker/filing.py`). Storage targets are rows in `storage_targets` (credentials encrypted with `SECRETS_KEY`, `src/lib/secrets.ts` and `secrets_box.py` share a format); shared and backup must be different accounts. Providers never overwrite or delete. Only admins connect, disconnect, verify or retry filing (`connections.manage`), and non-admins are never told where the backup is. Google Drive only runs in production mode; development files to `.data/targets/`. Never point a test at a real account.
- Review edits go through `src/lib/review/service.ts` (permission checks, audit log, soft delete, approval and the file name); server actions in `src/app/(app)/sermons/[id]/actions.ts` only call it. Passages keep `detected_original`. The file name stem is fixed at approval.
- The worker's Python package is found through `PYTHONPATH` (`worker/run.sh`, pytest config), not the editable-install `.pth`, which macOS can hide.
- `next dev` may re-add a Next.js agent-rules block to this file. It is generic guidance and safe to keep or remove.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
