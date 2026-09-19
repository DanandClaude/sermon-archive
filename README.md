# Sermon Archive

A free, self-hosted web app for churches that have old sermon tapes. People you choose upload digitized
cassette recordings. The app cleans up the audio, transcribes it on your own machine (no audio is sent to
a transcription service), names and categorizes each sermon, writes a short summary, lists the Bible
passages the pastor names aloud with the time each was spoken, and files everything to a shared Google Drive
plus an admin-only backup Drive. A person reviews and approves each sermon before it is filed.

Built for one church per installation. Church and speaker names are settings, so it isn't tied to any
congregation.

## What it does

- **Upload** tapes one at a time or in batches, with the date and passage from the tape label. Sides A and B
  can be separate files.
- **Clean up and transcribe** in the background, with word timings and the words the transcriber was unsure
  of underlined for review.
- **Suggest** a title, summary, tags and the scripture references, using Claude to read the transcript text.
  A fake analyzer is available for trying it without an account.
- **Review** on one screen: listen with a waveform, jump to any passage, add, edit or delete passages, edit
  the summary and details, and approve. Names follow `YYYY-MM-DD_Book-Chapter-Verse_ShortTitle`.
- **File and back up** approved sermons to two separate Google accounts, checking every file after it is
  written, with a nightly check for anything that has changed or gone missing.
- **Nightly database backups** to your storage bucket, kept 14 days plus 8 weeks of Sunday copies.
- **Roles:** admins run everything; contributors upload and approve their own; viewers see approved sermons.
  Sign-in is by emailed link, by invitation only.

Publishing to YouTube and a podcast feed is planned; see `SPEC.md`.

## Install it for your church

Follow **[deploy/INSTALL.md](deploy/INSTALL.md)**: a step-by-step guide to running it on a small rented server
with Docker. Restoring from a backup is in [deploy/RESTORE.md](deploy/RESTORE.md).

## Develop it

Start with [`CLAUDE.md`](CLAUDE.md) for commands and conventions and [`SPEC.md`](SPEC.md) for the full product
and technical spec. UI mockups are in [`design/`](design/), the audio worker is described in
[`worker/README.md`](worker/README.md), and a quick start is:

```sh
npm install
createdb sermon_archive && createdb sermon_archive_test
cp .env.example .env.local        # set APP_URL to the port you run on
npm run db:migrate
npm run admin:create -- --email you@example.org --name "Your Name"
npm run dev                       # sign-in emails appear at /dev/outbox
npm run worker:install && npm run worker
```

Development and tests never touch a real account: mail, storage, Google Drive and the analyzer all have
local fakes, and the real ones only run when `NODE_ENV=production` and `ADAPTER_MODE=real`.

## License

[MIT](LICENSE). The King James text used to build the Bible-chapter table is in the public domain.

## Where sermon content goes

- The app's own database and upload bucket (yours).
- Email addresses and names are used to send sign-in links through your SMTP provider. Sermon content is never emailed.
- Transcription runs on your own machine. No audio is sent to a transcription service.
- **Anthropic API (optional).** When `ANALYZER=anthropic`, the worker sends the transcript text (never audio) to Claude to write a title, summary and topic tags and to judge which passages were named. With the default `ANALYZER=fake`, nothing leaves your machine and the title and summary are placeholders.
- **Google Drive (production only).** Approved sermons are filed to two Drive accounts you connect: the shared archive drive (cleaned audio, transcript, subtitles, details) and an admin-only backup (also the original audio and word-timed transcript). The app asks Google only for access to the folders it creates itself, so it can't see anything else in those accounts. In development, "files" go to folders under `.data/targets/` and nothing leaves your machine.
- Not sent anywhere yet, and listed here when added: YouTube or a podcast host (Phase 5).
