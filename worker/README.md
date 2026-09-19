# Audio worker

Takes each uploaded tape through two steps and writes the results back:

1. **Clean up.** A gentle rumble filter, hum notches only if hum is detected, and loudness normalisation to about -16 LUFS. Denoising, click removal and declipping are available but off by default (see below). Writes a 192 kbps mono MP3 and waveform data for the original and the cleaned copy. The original is never touched.
2. **Transcribe.** Whisper with word timings and guards against inventing text over hiss and silence. Words it was unsure of are flagged, and long segments are split at sentence ends so timestamps are useful. Two engines: **MLX** (the Mac's GPU, fast) or **faster-whisper** (CPU, runs anywhere). By default it transcribes the original audio.

It runs on this Mac (or any Linux machine), talks only to your Postgres database and your upload storage, and sends no audio to a third party. The optional analysis step can send transcript text (only) to the Anthropic API; see _Analysis_ below. The app queues work in a `jobs` table; the worker claims jobs from it, so it can be stopped and started at any time and several workers can run at once.

## Set up

```sh
npm run worker:install        # Python virtual environment in worker/.venv (Python 3.12 or newer)
npm run worker:install-mlx    # Apple Silicon Macs only: adds the GPU engine (a large install; it brings PyTorch)
brew install ffmpeg           # if it isn't installed
```

The worker reads `DATABASE_URL` and the other settings from the repo's `.env.local` (see `.env.example`).

## Run

```sh
npm run worker                # run until stopped (Ctrl-C)
npm run worker:once           # process what is queued, then exit
```

`worker/run.sh` is the launcher. It sets `PYTHONPATH` because macOS can mark the editable-install `.pth` file as hidden, and Python then skips it.

The app's queue shows real progress. If the worker isn't running, the queue says processing is paused and your tapes wait safely. When the worker is offline for more than 90 seconds the app notices; it checks in every 15.

## Engines and models

The worker never downloads anything by itself. Set `TRANSCRIBER` in `.env.local`:

| `TRANSCRIBER`       | Runs on       | Model                                                        | Notes                                                                                      |
| ------------------- | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `mlx`               | the Mac's GPU | `MLX_MODEL`, default `mlx-community/whisper-large-v3-turbo`  | Apple Silicon only. Needs `npm run worker:install-mlx`.                                    |
| `whisper` (default) | the CPU       | `WHISPER_MODEL` (default `large-v3`) or `WHISPER_MODEL_PATH` | Works on any machine, including a Linux server.                                            |
| `fake`              | nothing       | none                                                         | Development only: canned text so the pipeline runs without a model. Refused in production. |

Each engine needs its own model file format, and models kept by other Whisper apps are not interchangeable: MLX models (used by `mlx_whisper`) work with `mlx`, faster-whisper models (a folder with `model.bin`) work with `whisper`, and whisper.cpp `ggml-*.bin` files (used by apps like Vibe) work with neither. Models in the Hugging Face cache (`~/.cache/huggingface/hub`) are found automatically and used offline.

Download a model on purpose, once:

```sh
worker/run.sh -m sermon_worker.fetch_model mlx-community/whisper-large-v3-turbo   # MLX, about 1.5 GB
worker/run.sh -m sermon_worker.fetch_model large-v3                              # faster-whisper, about 3 GB
```

**Measured on two real tape clips** (about 100 and 140 seconds, Apple M5):

| Engine                        | Speed                                                                             | Result                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MLX `large-v3-turbo`          | about 13 to 16x real time (a 45-minute side in under 4 minutes, cleanup included) | confidence 0.977; got the KJV scripture wording right                                |
| faster-whisper `medium` (CPU) | about 4x real time                                                                | confidence 0.937; agreed on 97.8% of words, and the differences were medium's errors |

Two clips from one speaker is a small sample, so treat it as good early evidence, not a guarantee. A second opt-in test runs each engine on generated speech: `WHISPER_TEST_MODEL=medium WHISPER_TEST_MLX=1 worker/run.sh -m pytest tests/test_real_model.py` (macOS only; never downloads).

## What the cleanup does, and why

The defaults come from testing on real tapes (`TAPE002` and `TAPE003`), where **transcription was as good or better on audio that had been changed the least**:

- The clips had no mains hum, and a notch at 120 or 180 Hz cuts into a male voice. So hum notches are added only when hum is detected (a narrow spike at 50 or 60 Hz and its multiples).
- Denoising and click removal did not help transcription and slightly lowered its confidence, so they are off.
- The clips were recorded very hot (about -7 LUFS, 3% of samples clipped). Normalising to -16 LUFS is what makes the cleaned copy comfortable to listen to. `declip` is available for tapes like this.
- So the worker transcribes the **original** audio by default (`TRANSCRIBE_SOURCE=original`). Set `cleaned` for a tape too noisy to transcribe as recorded.

Cleanup is therefore mostly for listening. To compare versions by ear, and by number, on any tape:

```sh
worker/run.sh -m sermon_worker.experiments /full/path/to/tape.mp3 --out /full/path/to/folder
worker/run.sh -m sermon_worker.experiments /full/path/to/tape.mp3 --out /full/path/to/folder --transcribe
```

It writes one MP3 per variant (default, declip, denoise, and so on) and prints loudness and hum. With `--transcribe` it also prints word confidence. Use full paths, because the launcher changes directory. Change the winning settings in `CleanConfig` (`src/sermon_worker/clean.py`).

Tape wobble and flutter are not corrected.

## Keep it running on this Mac

To start the worker at login and restart it if it stops:

```sh
worker/deploy/install-launchd.sh        # remove with worker/deploy/uninstall-launchd.sh
```

Log: `~/Library/Logs/sermon-worker.log`. Two things to know:

- The Mac must be awake and online to process tapes. In System Settings, Energy, allow it to stay awake when the display is off. If it sleeps, the app shows that processing is paused.
- macOS may ask for permission to use files in the Documents folder the first time the service runs.

These files are checked for syntax but the install has not been run end to end.

3. **Analyze.** Finds the passages the pastor names aloud, then writes a title, a short summary and topic tags.

## Analysis

Runs after transcription (`analyze` job). Nothing here touches audio.

- **Passages.** `parser.py` reads the word-timed transcript for spoken and written references ("First Peter chapter five verses two and three", "Hebrews 13:17", "Psalm twenty-three"), follows "verse 5" or "chapter 4 verse 2" from the last book named, and checks each one against the canon (`shared/canon.json`, chapter and verse counts derived from the public-domain KJV). It errs toward proposing too much. The analyzer then rejects false ones, corrects a chapter it guessed wrong, and adds passages the parser missed (each must quote the words from the transcript, so it can be timed). `analysis.py` merges repeat mentions into one entry at the earliest time and picks the main text. The tape label the contributor typed always wins as the main passage.
- **Analyzers.** `ANALYZER=fake` needs nothing and writes placeholder text (refused in production). `ANALYZER=anthropic` sends the timed transcript text and the candidate list to Claude (`ANTHROPIC_MODEL`, default `claude-sonnet-5`) and asks for JSON that matches a schema. Setup problems (bad key, unknown model) fail the sermon with a plain message; rate limits and outages retry with backoff. The raw answer, model and prompt version are kept in `analyses`.
- **What it will not overwrite.** A title already typed, a summary a person edited, a main passage already chosen, and passages a person added, corrected or deleted. Regenerate in the app queues an `analyze` job with `{"only": "summary"}`.
- **Old transcripts.** On start, and every minute, the worker queues analysis for any sermon waiting at "analyzing" that has no job.

## Filing and backup

Approving a sermon queues a `file` job. The worker writes the sermon's files to the **shared archive drive** and the **admin backup**, each on its own account (`filing.py`, `providers.py`, `drive.py`):

- Shared: `{decade}s/{year}/{stem}/{stem}.mp3, .txt, .srt, .json`. Backup: the same folder plus `{stem}_original.<ext>` (byte for byte) and `{stem}_transcript.json` (word timings).
- Text and subtitles are rendered by `render.py`, a port of the app's renderer; `shared/transcript-cases.json` keeps them identical.
- **Never overwrites.** A file that is already there with the same content is adopted, so a retry after a partial failure carries on where it stopped. A different file at the same path stops the job with a plain message.
- Every file is read back and its checksum compared (MD5 for Drive) with our own SHA-256 also kept. Only then is the sermon marked `filed`. If either target fails, the sermon stays `approved` with the reason shown, and retries with backoff (an admin can press "File again").
- Credentials are read from `storage_targets`, decrypted with `SECRETS_KEY` (`secrets_box.py`, format shared with the app and tested with `shared/secrets-cases.json`).
- **Google Drive** uses ordinary folders and the `drive.file` scope (only what the app creates), so it needs no Google Workspace. It is refused unless `ADAPTER_MODE=real` in production; in development a target is a local folder. The Drive provider is tested against a stand-in Google service, never the real one.
- **Verification** (`verify.py`): "Verify now" on the Connections page, and a nightly run after 3 a.m., look every filed file up again. A changed file is `drifted`, a removed one `missing`. Nothing is repaired automatically.

Set `SECRETS_KEY` (and, for real Drive, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) in the worker's environment the same as the app's.

## Storage

Same layout as the app: originals under `originals/`, and everything the worker makes under `cleaned/` and `peaks/`. Keys include the job id, so a retry writes new objects instead of editing old ones. The worker refuses to write under `originals/` at all. In development it reads and writes `.data/uploads`; with `ADAPTER_MODE=real` (production only) it uses the same S3 bucket as the app.

## Tests

```sh
npm run worker:test           # about 380 tests: real ffmpeg, a real Postgres database, scripted and stubbed transcribers and analyzers
npm run worker:lint
```

Tests use a separate database ending in `_test`, built from the app's own migrations, and never need the Whisper model. One opt-in test runs a real model on generated speech: `WHISPER_TEST_MODEL=medium worker/run.sh -m pytest tests/test_real_model.py` (macOS only; it never downloads).

## Not built yet

- A container image. Docker isn't installed on the development machine, so none is provided rather than an untested one.
- Resuming a transcription that was interrupted part way. A retry restarts that step.
