# Sermon Archive

A web app where designated people upload digitized cassette-tape sermons. It cleans up the audio, transcribes it, names and categorizes each sermon, lists the Bible passages the pastor names aloud, and files everything to a shared drive plus an admin-only backup.

Start with [`CLAUDE.md`](CLAUDE.md) for commands and conventions, and [`SPEC.md`](SPEC.md) for the full product and technical spec. UI mockups are in [`design/`](design/).

## Status

- Phase 0 (scaffold): done.
- Phase 1 (sign-in, roles, uploads): done. Admins add people, everyone signs in with an emailed link, contributors upload batches of tapes with per-tape details, and the library lists what each person is allowed to see.
- Phase 2 (cleanup and transcription): done. A Python worker cleans each tape's audio and transcribes it in-house with word timings; the queue shows real progress and failures with a Retry button. See [`worker/README.md`](worker/README.md).
- Review, filing and publishing come in later phases (SPEC §14). A finished transcript waits as "Transcript ready" until Phase 3.

## Setting up storage and email for a real deployment

Set `NODE_ENV=production`, `ADAPTER_MODE=real` and the variables in `.env.example`. Nothing is sent to real services in development or tests.

**Upload bucket (AWS S3 or an S3-compatible service).** Browsers upload audio straight to it.

- Give the app credentials that can create, upload to, list, read and abort multipart uploads in one bucket (standard `AWS_*` variables or an instance role).
- Add a CORS rule that allows `PUT` from your `APP_URL`.
- Add a lifecycle rule that aborts incomplete multipart uploads after a few days.
- Keep the bucket private. The app never makes it public.

**Email.** Sign-in links are sent over SMTP (`SMTP_URL`, `MAIL_FROM`). Any provider works (Postmark, Resend, Amazon SES, a Google Workspace relay). Set up SPF and DKIM for the sending domain, or links may land in spam.

**Audio worker.** Run it on a machine that stays on (`worker/README.md`). It needs the same database and storage settings as the app, plus ffmpeg and the Whisper model.

**First admin.** Run `npm run admin:create -- --email you@example.org --name "Your Name"` on the server. It prints a one-time sign-in link.

## Where sermon content goes

- The app's own database and upload bucket (yours).
- Email addresses and names are used to send sign-in links through your SMTP provider. Sermon content is never emailed.
- Transcription runs on your own machine. No audio is sent to a transcription service.
- **Anthropic API (optional).** When `ANALYZER=anthropic`, the worker sends the transcript text (never audio) to Claude to write a title, summary and topic tags and to judge which passages were named. With the default `ANALYZER=fake`, nothing leaves your machine and the title and summary are placeholders.
- **Google Drive (production only).** Approved sermons are filed to two Drive accounts you connect: the shared archive drive (cleaned audio, transcript, subtitles, details) and an admin-only backup (also the original audio and word-timed transcript). The app asks Google only for access to the folders it creates itself, so it can't see anything else in those accounts. In development, "files" go to folders under `.data/targets/` and nothing leaves your machine.
- Not sent anywhere yet, and listed here when added: YouTube or a podcast host (Phase 5).
