# Audio worker

Takes each uploaded tape through two steps and writes the results back:

1. **Clean up.** High-pass, mains-hum notches, FFT denoise, click removal, then loudness normalisation to about -16 LUFS. Writes a 192 kbps mono MP3 and waveform data for the original and the cleaned copy. The original is never touched.
2. **Transcribe.** faster-whisper (CTranslate2) with word timings, voice-activity detection and guards against Whisper inventing text over hiss and silence. Words it was unsure of are flagged.

It runs on this Mac (or any Linux machine), talks only to your Postgres database and your upload storage, and sends nothing to a third party. The app queues work in a `jobs` table; the worker claims jobs from it, so it can be stopped and started at any time and several workers can run at once.

## Set up

```sh
npm run worker:install        # Python virtual environment in worker/.venv (Python 3.12 or newer)
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

## The Whisper model

The worker will not download anything by itself. Download the model once, on purpose:

```sh
worker/run.sh -m sermon_worker.fetch_model large-v3     # about 3 GB
```

Then it is used automatically (`WHISPER_MODEL=large-v3`, `WHISPER_COMPUTE=int8`). Until then a transcription job fails with "The transcription model is not installed on the worker" and can be retried from the app once the model is there.

To try the pipeline without a model, set `TRANSCRIBER=fake`. It writes canned text and is refused when `NODE_ENV=production`.

## Tuning the cleanup

The defaults are a starting point. Compare them on a real tape:

```sh
worker/run.sh -m sermon_worker.experiments tape.mp3 --out /tmp/tape-test
worker/run.sh -m sermon_worker.experiments tape.mp3 --out /tmp/tape-test --transcribe   # needs the model
```

It writes one MP3 per variant and prints loudness and how much hum is left. With `--transcribe` it also prints the average word confidence per variant. Heavy denoising can sound cleaner but transcribe worse, so listen and check the number. Change the winning settings in `CleanConfig` (`src/sermon_worker/clean.py`).

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

## Storage

Same layout as the app: originals under `originals/`, and everything the worker makes under `cleaned/` and `peaks/`. Keys include the job id, so a retry writes new objects instead of editing old ones. The worker refuses to write under `originals/` at all. In development it reads and writes `.data/uploads`; with `ADAPTER_MODE=real` (production only) it uses the same S3 bucket as the app.

## Tests

```sh
npm run worker:test           # 119 tests: real ffmpeg, a real Postgres database, a scripted transcriber
npm run worker:lint
```

Tests use a separate database ending in `_test`, built from the app's own migrations, and never need the Whisper model.

## Not built yet

- A container image. Docker isn't installed on the development machine, so none is provided rather than an untested one.
- Resuming a transcription that was interrupted part way. A retry restarts that step.
