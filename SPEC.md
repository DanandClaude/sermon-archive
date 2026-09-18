# Sermon Archive (web) — Product & Technical Spec

Status: draft handoff from the design phase. Sample names, sermons and data in the mockup are fictional.

---

## 1. Goals

1. Let designated people at different locations upload digitized cassette sermons without any technical setup.
2. Automatically clean up, transcribe, name, categorize and summarize each sermon, and list the Bible passages the pastor names aloud, with timestamps.
3. Give a human a fast review step before anything is filed.
4. File approved sermons to a shared drive (everyone can browse) **and** an admin-only backup vault.
5. Let admins publish approved sermons to YouTube and/or a podcast feed.

Non-goals (for now): live recording, video sermons, multi-church tenancy, public website, editing audio by hand, non-English sermons.

## 2. Roles and permissions

| Capability | Viewer | Contributor | Admin |
|---|---|---|---|
| Browse library, play audio, read transcripts | yes | yes | yes |
| Upload tapes | – | yes | yes |
| Edit details, summary, passages on a sermon (before approval) | – | yes (own uploads; see D2) | yes (all) |
| Approve & file | – | yes (own uploads; see D1) | yes |
| Edit after approval | – | no | yes |
| Open the backup vault | – | no | yes |
| Connect/disconnect storage and channels, change publishing rules | – | no | yes |
| Publish to YouTube / podcast | – | no | yes |
| Invite/remove people, change roles | – | no | yes |
| Change church name and default speaker | – | no | yes |

All checks are server-side. There must always be at least one admin.

## 3. Core flow

1. **Upload** (contributor): drag files in; optionally enter tape label data (date, scripture, speaker, box/batch). Resumable, direct-to-storage upload; multiple files at once; sides A/B may be separate files.
2. **Process** (automatic): clean up → transcribe → analyze (name, categorize, summarize, scripture references). Contributor sees live progress in the queue.
3. **Review** (contributor): listen (original vs cleaned), read transcript (low-confidence words flagged), fix title/date/passage/tags/summary/scripture list, then **Approve & file**.
4. **File** (automatic on approval): write outputs to the shared drive and the admin backup vault, verify checksums.
5. **Publish** (admin, optional): send to YouTube and/or podcast per publishing rules.

## 4. Processing pipeline

States: `uploading → uploaded → cleaning → transcribing → analyzing → needs_review → approved → filing → filed`, plus `failed` (with the stage that failed and a retry action). `published` is tracked per channel in `publications`, not on the sermon.

Each stage is a background job: idempotent, retryable (with backoff), resumable, and writes new assets rather than mutating old ones.

### 4.1 Clean up
- Input: original file (WAV/MP3/M4A/AIFF/FLAC). Decode with ffmpeg, work in 16-bit or 24-bit PCM.
- Suggested chain (tune on real tapes): high-pass around 60–80 Hz, hum notch filters (50/60 Hz and harmonics as needed), FFT denoise (`afftdn`), optional click removal (`adeclick`), loudness normalization (`loudnorm`, target about -16 LUFS for speech).
- Consider an ML denoiser (e.g. RNNoise or DeepFilterNet) as an option if ffmpeg filters aren't enough. Evaluate on a handful of real tapes and keep whichever sounds natural; over-aggressive denoising hurts transcription.
- Do **not** promise tape wobble/flutter correction. It isn't reliably fixable with these tools.
- Output: cleaned audio (MP3 ~192 kbps or AAC for sharing; keep a lossless intermediate only if storage allows). The original is never touched.
- Store a small waveform/peaks JSON for both original and cleaned so the UI can draw them without decoding audio.

### 4.2 Transcribe
- Whisper family. Recommended: `faster-whisper` (CTranslate2) with a large-v3-class model, word-level timestamps, VAD filtering. Alternatives: whisper.cpp, or a hosted transcription API. See D3.
- Transcribe the **cleaned** audio by default; keep an option to fall back to the original if the cleaned version transcribes worse.
- Pass an initial prompt containing Bible book names, common biblical names and the speaker's name to improve accuracy on scripture vocabulary.
- Language: English. Profile: American English, Southern accent (informational; Whisper has no accent switch, so the prompt and model size do the work).
- Output: segments with start/end and per-word timings and confidence; full plain text; SRT and VTT. Flag words below a confidence threshold as `low_confidence` so the review UI can underline them.
- Split long audio into overlapping chunks if needed; stitch timestamps back carefully and test the seams.

### 4.3 Analyze
Runs on the transcript (text + timing). Use the Anthropic API with a current Sonnet-class model (check docs for the current model string) using structured (JSON-schema) output. A 45-minute sermon is roughly 6–8k words and fits in one request.
- **Title suggestion** (short, 2–6 words, no colons/quotes).
- **Categories/tags**: testament (Old/New), genre (Law, History, Wisdom, Psalm, Prophecy, Gospel, Epistle, Apocalyptic), primary book, plus 1–3 topic tags. Keep topic tags from a controlled, growing list so tags stay consistent across sermons.
- **Summary**: 2–4 sentences, plain and faithful to what was said. Do not add theology the pastor didn't say. Reviewer can edit; regenerate is available.
- **Primary passage**: from the contributor's label if present, else detected (the passage the pastor announces or spends the most time on).
- **Scripture references**: see §5.
- Keep the raw model output and prompt version on the record for debugging.

## 5. Scripture references

Requirement: list every passage the pastor **names out loud**, with the time it was spoken. Do not list passages merely quoted or alluded to without being named. (Optional future feature: "possible references".)

Detection is a hybrid:
1. **Deterministic parser** over the word-timed transcript for spoken forms: "Romans thirteen one and two", "First Peter chapter five verses two and three", "turn to Psalm twenty-three", "verse seventeen" (relative to the last named book/chapter), "verse seven of this same chapter". Handle number words → digits, ordinals ("First/1st/I Peter"), aliases ("Psalm/Psalms", "Song of Solomon/Song of Songs"), ranges ("verses 26 and 27", "26 through 29").
2. **LLM pass** to catch what the parser missed and resolve ambiguity, returning book, chapter, verse range, spoken time, confidence, and a short context note.
3. **Validation** against a canon table (66-book Protestant canon; chapter and verse counts). Reject or flag impossible references (e.g. Romans 99:1). Generate the canon table from a public-domain source and add tests; don't type it from memory.
4. **Merge and de-duplicate**: keep one entry per distinct passage per mention cluster; use the earliest spoken time in the cluster. Mark the main text with `is_main_text`.

Storage keeps both `detected_original` (what the system found) and the current value, plus `source` (`auto` or `manual`), `edited_by` and `edited_at`.

**Reviewer editing (required):** reviewers can
- **edit** an entry: book (select), chapter, verse start/end, timestamp (with a "use current playback time" button), context note, main-text flag;
- **add** a passage the system missed;
- **delete** an entry (soft delete, recorded in the audit log).

Timestamps are clickable: they seek the player. Show the currently playing passage highlighted.

## 6. Naming and categorization

Filename stem: `YYYY-MM-DD_Book-Chapter-Verse_ShortTitle`
- Example: `1988-03-13_Hebrews-13-17_Submitting-to-Leaders`
- Verse ranges: `Romans-8-28-39`. Whole-chapter: `Psalm-23`. Numbered books: `1-Peter-5-2-3`. Title in Title-Case-With-Hyphens; strip punctuation, apostrophes and accents; cap ShortTitle around 40 characters.
- Missing date: `undated_<batch>-<tape>_...`; the review screen must make this obvious and easy to fix.
- Collisions (same stem): append `_2`, `_3`.
- Two-sided tapes: sides that turn out to be one sermon can be merged in review (see D6); otherwise each side is its own sermon.
- The stem is regenerated when title, date or primary passage changes, until the sermon is approved; after approval, renames are admin-only and re-sync to storage.
- Date rule: contributor-entered label date wins over detected date. Record `date_source`.

## 7. Storage and backup

Two independent targets, both configured by an admin:

**Shared archive drive** (everyone can browse through the app)
- Layout: `Sermon Archive / {decade}s / {year} / {stem} / {stem}.mp3, .txt, .srt, .json`
- Contents: cleaned audio, transcript text, subtitles, metadata JSON (title, date, summary, passages with timestamps, tags).

**Admin backup vault** (only admins can open it)
- A separate account or shared drive that only admins belong to. Contributors and viewers have no access and the app never exposes it to them.
- Contents: original audio (untouched), cleaned audio, transcript JSON with word timings, text, SRT, metadata JSON.
- Runs automatically after each approval, as part of the same filing job.
- Verification: store SHA-256 locally and compare against the remote checksum (Drive exposes MD5 for binary files; use whichever the provider gives and also keep your own hash). "Verify now" re-checks everything and reports drift. Nightly verification job.

Filing job rules: upload to both targets, verify both, and only then mark `filed`. If either fails, keep the sermon `approved` with a visible error and retry with backoff. Never partially report success.

Provider: the mockup assumes Google Drive (shared drives; use `supportsAllDrives`, resumable uploads). Keep a `StorageProvider` interface so Dropbox/OneDrive/S3 can be added later. See D4 for how contributors access files.

## 8. Distribution (admin only)

Publishing rules (settings): only admins can publish; only Approved sermons are eligible; default to unlisted/draft; include summary, scripture list and transcript in show notes.

**YouTube** (YouTube Data API v3, OAuth as the admin)
- YouTube needs video, so render an MP4 from the cleaned audio plus a static cover image (ffmpeg). Cover art template should show title, scripture, date.
- Upload with title, description (summary + scripture list with timestamps + transcript excerpt), default privacy `unlisted`; then upload captions (SRT).
- Known constraints to verify against current docs before building: daily API quota (video upload is expensive, so roughly a handful of uploads per day at default quota), and the policy that videos uploaded through API projects that haven't passed YouTube's compliance audit may be locked to private. Plan for a quota-increase/audit request if needed, and design the queue so publishes can be spread over days.

**Podcast**
- Option A (simplest, recommended for MVP): the app generates a standards-compliant RSS 2.0 feed (iTunes tags, and `podcast:transcript` for the SRT) from published sermons and serves audio at stable public URLs. The admin submits the feed URL to podcast directories.
- Option B: connect to a podcast host's API to create episodes. Host APIs differ; build one adapter for the host the owner actually uses.
- Note: podcast feeds have no true "unlisted"; publishing the episode makes the audio public. The UI must warn before the first publish to a podcast channel.

Publications are tracked per sermon per channel (`draft → queued → published → failed`), with the remote URL/ID. Unpublish/remove is admin-only.

## 9. Data model (Postgres; adjust as needed)

- `users` (id, email, name, role `admin|contributor|viewer`, location_label, disabled_at)
- `sermons` (id, status, title, short_title, filename_stem, recorded_on, date_source `label|audio|manual`, speaker, series, contributor_id, batch_label, side, duration_sec, summary_text, summary_source `auto|edited`, primary_passage (json), approved_at, approved_by, created_at)
- `audio_assets` (id, sermon_id, kind `original|cleaned|video_render`, storage_key, sha256, bytes, mime, duration_sec, peaks_key)
- `transcripts` (id, sermon_id, version, model, language, full_text, segments jsonb [start,end,text,words[{w,start,end,prob}]], low_confidence jsonb)
- `scripture_refs` (id, sermon_id, book, chapter, verse_start, verse_end, spoken_at_sec, context_note, is_main_text, source `auto|manual`, confidence, detected_original jsonb, edited_by, edited_at, deleted_at)
- `tags` (id, name, kind `testament|genre|book|topic`) and `sermon_tags`
- `jobs` (id, sermon_id, type, state, attempts, last_error, payload, started_at, finished_at)
- `storage_targets` (id, kind `shared|backup`, provider, encrypted_config, connected_by, last_verified_at)
- `storage_objects` (id, sermon_id, target_id, path, remote_id, sha256, remote_checksum, state, verified_at)
- `distribution_channels` (id, kind `youtube|podcast`, encrypted_config, connected_by, default_visibility)
- `publications` (id, sermon_id, channel_id, state, remote_id, remote_url, published_by, published_at, last_error)
- `settings` (key/value: church name, default speaker, publishing rules, naming options)
- `audit_log` (id, actor_id, action, entity, entity_id (text), diff jsonb, at)

## 10. Screens (mockups in `design/`)

Mocked: **Upload** (`1-upload.dc.html`), **Library** (`2-library.dc.html`), **Review a sermon** (`3-review-sermon.dc.html`), **Admin: connections** (`4-admin-connections.dc.html`).

Not mocked yet, needed for a working app (design them in the same style as you build):
- Sign-in, invite acceptance, and role-aware navigation (contributors don't see Admin).
- **Settings** page (church name, default speaker). Built in Phase 0.
- **Team & access** page (list, invite, change role, remove). The mockup's "Team & access" link currently points at the Admin page.
- Empty states (no sermons, no connections), error states (failed job with retry, upload interrupted, storage disconnected).
- **Edit passage** and **Add passage** dialogs (fields in §5).
- Connect flows for Google Drive (shared + backup), YouTube, podcast.
- Publish dialog (channel, visibility, preview of title/description/cover) and a publish queue/status view.
- Library **Grid** view and the filters (book, category, decade, contributor) actually working; global search across titles, passages and transcript text.
- Responsive layouts. The mockup is 1440px desktop; contributors may use laptops or tablets.
- Accessibility: keyboard navigable, visible focus, labels on inputs and icon buttons, 4.5:1 text contrast (the mockup was built to this).

Behaviors to get right in the Review screen: original/cleaned toggle swaps the audio source without losing position; clicking a transcript paragraph or a passage seeks the player; editing the transcript text is allowed (and re-generates SRT); amber-underlined words show alternatives if available; "Approve & file" is disabled until required fields (date, primary passage, title) are valid.

Copy note: the Upload screen previously mentioned "tape wobble"; that was removed because it's not a promised feature.

## 11. Recommended stack (proposal, not a mandate)

- **Web app:** TypeScript + Next.js (App Router), Tailwind or CSS variables for the tokens in §16, component library kept minimal.
- **API/DB:** Postgres with Prisma or Drizzle; migrations checked in.
- **Auth:** email magic link or Google sign-in via an established library (Auth.js, or a hosted provider). Roles in the DB.
- **Object storage:** S3-compatible bucket (presigned multipart/resumable uploads straight from the browser; short-lived signed URLs for playback).
- **Queue/workers:** a job queue (BullMQ + Redis, or Postgres-based such as pg-boss). Audio and ML work runs in a separate **Python worker** (ffmpeg, faster-whisper) so the web app stays light.
- **LLM:** Anthropic API for analysis (structured output).
- **Integrations:** Google Drive API, YouTube Data API v3, RSS generation.
- **Hosting:** decide in D3; keep web and worker separately deployable; containerize the worker.
- **Testing:** unit tests for parsing/naming/state machine; integration tests with fake adapters; a small set of real audio fixtures (short clips) checked in for pipeline tests.

## 12. Security and privacy

- Enforce roles server-side on every route, job and signed-URL issuance. Test the permission matrix.
- Encrypt OAuth tokens and secrets at rest; scope them minimally; rotate on disconnect. The backup vault credential is stored separately and only usable by admin-initiated or system jobs.
- Signed URLs expire quickly; no public buckets except podcast audio that an admin has explicitly published.
- Audit log for: uploads, approvals, edits after approval, connect/disconnect, publish/unpublish, role changes, backup verification results.
- Rate-limit auth and upload endpoints; validate file types and sizes; process uploads in a sandboxed worker.
- No sermon content is sent to third parties beyond the configured transcription/LLM/storage/distribution providers; document exactly which ones in the README.
- Soft-delete everywhere; hard delete only by an admin, and never of a backup object without a second confirmation.

## 13. Sample data and fixtures

The mockup's sermons (Hebrews 13:17 "Submitting to Leaders", etc.) are illustrative. For development, create a `fixtures/` folder with a few short public-domain or self-recorded audio clips, plus hand-written transcript JSON samples for testing the scripture parser (spoken-form variants listed in §5).

## 14. Build phases

Each phase ends with something demoable. Post a plan before starting each one.

**Phase 0 — Decisions and scaffold**
Resolve or default the open decisions (§15). Scaffold repo, CI, lint/test, DB, env handling, design tokens, base layout with sidebar. Fake adapters for storage/YouTube/podcast.
*Done when:* app boots, DB migrates, tests run in CI, the shell matches the mockup's sidebar and styling.

**Phase 1 — Auth, roles, uploads**
Sign-in, invites, roles, permission tests. Upload screen with resumable uploads, tape details, queue with real statuses. Library list (basic) and sermon record creation.
*Done when:* a contributor can upload a multi-file batch, see it in the queue, and a viewer can't.
*Built as (2026-09-18):* magic-link sign-in with an in-house implementation (one-time links stored as hashes, server-side sessions, a confirm button so email scanners can't spend a link) instead of an auth library, because the users table already carries role and disabled state and only one method is needed. `getCurrentUser()` is the seam if a library is preferred later. People are added by an admin as users (name, email, location, role); there is no separate `invites` table. The `jobs` table moves to Phase 2 with the worker that uses it. Uploads go straight from the browser to S3-compatible storage with presigned multipart URLs; development uses a local-disk fake.

**Phase 2 — Cleanup and transcription**
Python worker; cleanup chain; transcription with word timings; peaks JSON; SRT/VTT; job retries and failure UI.
*Done when:* a real tape side becomes cleaned audio + transcript, and failures can be retried from the UI.

**Phase 3 — Analysis and review**
Title/categories/summary via LLM; scripture detection (parser + LLM + validation); naming; the full Review screen including passage add/edit/delete and player syncing.
*Done when:* a reviewer can fix everything on a sermon and approve it; passage edits are audited.

**Phase 4 — Filing and backup**
Storage provider interface, Google Drive adapter for both targets, filing job with checksum verification, "Verify now" and nightly verification, admin Connections screen for storage.
*Done when:* approving a sermon produces correct files in both targets and drift is detected in a test.

**Phase 5 — Distribution**
YouTube adapter (video render, captions, unlisted default), podcast RSS feed, publishing rules, publish dialog/queue, admin-only enforcement.
*Done when:* an admin can publish an approved sermon to a test channel/feed and unpublish it; contributors can't.

**Phase 6 — Polish and hardening**
Library filters/search/grid, Team & access page, responsive layouts, accessibility pass, error/empty states, backups of the app's own database, observability, documentation.
*Done when:* an end-to-end run with real tapes works without developer help.

## 15. Open decisions (ask the owner; propose a default)

- **D1 — Who approves?** Default in the mockup: contributors approve their own sermons. Alternative: an admin sign-off queue before filing. **Decided 2026-09-18:** contributors approve their own sermons; admins can approve any. Approval goes through one policy function (`canApproveSermon`) so an admin sign-off step can be added later.
- **D2 — Can contributors edit each other's uploads?** Default: no, only their own and admins.
- **D3 — Where do transcription and audio jobs run?** Options: managed GPU service; a hosted transcription API; a self-hosted worker (for example on the owner's Mac from the v1 app). Affects cost, speed and privacy. **Decided 2026-09-18:** in-house transcription (self-hosted faster-whisper). No sermon audio goes to a hosted transcription service. Which machine runs the worker is still open.
- **D4 — How do contributors see the shared drive?** Default: only through the app (app streams files, no Drive accounts needed). Alternative: also grant them direct Drive access.
- **D5 — Storage provider.** Default: Google Drive for both targets. Confirm what the owner actually has. **Decided 2026-09-18:** Google Drive first, with other providers (AWS S3, OneDrive, Dropbox and more) pluggable later. Providers report different checksums, so each `StorageProvider` declares its algorithm. Shared drives need Google Workspace; confirm the church has it.
- **D6 — Two-sided tapes:** merge sides into one sermon, or keep each side a separate record? Default: separate, with a "merge" action.
- **D7 — Distribution order.** Default: YouTube first, then podcast RSS.
- **D8 — Volume and hosting budget.** Roughly how many tapes and how many contributors? This sizes compute and storage. **Partly answered 2026-09-18:** tapes will arrive as MP3 at first. Preferred where possible: WAV or FLAC, mono, 16-bit, 44.1 kHz (the upload is the permanent original). MP3 should be 192 kbps or higher. **Scale (2026-09-18):** hundreds of tapes, so roughly a thousand or more sides; the Library, review queue and processing throughput must handle that from the start. Contributors are set up by an admin as users with simple profiles. **Arrival pattern (2026-09-18):** tapes will be uploaded one at a time or in very small batches, so there is no bulk-ingest burst; total volume is still hundreds of tapes over time. Still needed: exact tape count, number of contributors and locations.
- **D9 — Sign-in method.** Default: Google sign-in plus email magic link. **Decided 2026-09-18:** email magic link only, invite-only (an admin adds each person; there is no self-signup). Google sign-in can be added later without changing the users table.
- **D10 — Retention.** Keep originals forever (default). Any deletion rules?
- **D11 — Who sees unapproved sermons?** **Decided 2026-09-18:** viewers see approved sermons only; contributors see their own drafts plus approved sermons; admins see everything. Enforced in `canViewSermon`.
- **D12 — Other churches.** The owner may offer the app to other churches, so church name and default speaker are settings, never hardcoded. **Confirmed 2026-09-18:** one deployment per church, with no shared multi-tenancy (the §1 non-goal stands).

## 16. Design tokens

Colors: ground `#F6F3EC`; surface `#FFFFFF`; ink `#1E1D1A`; muted text `#5E584E`; faint text `#6F695E`; line `#E5DFD3`; strong line `#D6CEBE`; accent spruce `#1F5C52`, tint `#E3EFEB`, mid tint `#EAF3EF`; sidebar `#14201D` (active `#22322D`, muted text `#93A19A`, body `#C9D1CB`); amber `#E19A1F`, tint `#FBEFD9`, text `#8A5200`, underline `#B26A00`; danger `#A23B2A`; neutral chip `#EFEAE0`.
Type: Fraunces 600 for headings (page title 36–38px); Instrument Sans for UI (body 14–14.5px, labels 13px semi-bold); IBM Plex Mono for file names and timestamps.
Shape: cards radius 16px with 1px `#E5DFD3` border; buttons and inputs radius 10–12px, 44px min height; chips fully rounded.
Waveform: 5px bars, 2.2px gap, cleaned in spruce (played) / `#B7CFC8` (unplayed), original in warm gray.
No emoji, no gradient washes; icons are simple 1.75px-stroke line icons.
