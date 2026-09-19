# Installing Sermon Archive for your church

This guide sets up one Sermon Archive for one church on a small rented server. Plan on an afternoon
the first time, most of it waiting for accounts to be created. You don't need to be a programmer, but
you do need to be comfortable typing a few commands, or have a volunteer who is.

**What it costs (rough, check current prices):** the server $10–25 a month, a domain about $12 a year,
recording storage a dollar or two a month, and about 3–5 cents in Claude charges per tape.

## What you'll set up

| You need                                       | What it's for                                        | Examples                                                                      |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| A server                                       | Runs the app                                         | Hetzner Cloud, DigitalOcean, Linode (Ubuntu 24.04, 4 processors, 8 GB memory) |
| A domain name                                  | Your archive's address, and HTTPS                    | Any registrar                                                                 |
| A storage bucket                               | Recordings and database backups                      | Backblaze B2, Cloudflare R2, Amazon S3                                        |
| An email sender                                | Sign-in links                                        | Postmark, Resend, Amazon SES, your church's mail                              |
| An Anthropic key                               | Titles, summaries, checking passages                 | console.anthropic.com                                                         |
| Two Google accounts and a Google Cloud project | Filing to Google Drive (shared drive + admin backup) | Free                                                                          |

Nothing here is sent anywhere until you connect it. Audio is never sent to a transcription service:
transcription runs on your own server or computer.

---

## 1. The server and the domain

1. Create a server with **Ubuntu 24.04**, at least **4 processors and 8 GB of memory**, and **60 GB of disk**.
2. In your domain's settings, add an **A record** for a name such as `archive.yourchurch.org` that points at
   the server's IP address. Wait a few minutes.
3. Connect to the server (`ssh root@your-server-ip`) and install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Get the Sermon Archive files onto the server:
   ```bash
   git clone https://github.com/DanandClaude/sermon-archive.git
   cd sermon-archive/deploy
   ```

## 2. The storage bucket

Create a **private** bucket. Then:

- **Access key.** Create a key that can read, write and delete objects in this one bucket only.
- **CORS rule.** Browsers upload recordings straight to the bucket, so allow `PUT` (and `GET`, `HEAD`) from
  `https://archive.yourchurch.org`, with all headers allowed and `ETag` exposed.
- **Clean-up rule.** Add a lifecycle rule that aborts incomplete multipart uploads after 3 days.
- Note the **bucket name**, **region**, and (for services other than Amazon) the **endpoint address**.

The same bucket also holds the nightly database backups, under `db-backups/`.

## 3. Email

Create an account with an email provider, verify your sending domain (SPF and DKIM, or sign-in emails
will land in spam), and copy the **SMTP address**, which looks like `smtp://user:password@host:587`.

## 4. Google (for filing to Google Drive)

Sermons are filed to two **different** Google accounts: a shared archive drive and an admin-only backup.
Ordinary Google accounts work; you don't need Google Workspace.

1. Go to console.cloud.google.com and create a project (any name).
2. **APIs & Services → Library:** enable **Google Drive API**.
3. **OAuth consent screen:** choose **External**, fill in the app name and your email, and add the scopes
   `.../auth/drive.file`, `openid` and `email`. While the app is in "Testing", add the two Google accounts as
   **test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under _Authorised redirect URIs_
   add `https://archive.yourchurch.org/api/connections/google/callback`.
5. Copy the **Client ID** and **Client secret**.

The app can only see folders it creates itself in each Drive; it can't read anything else in those accounts.

## 5. Fill in your settings

```bash
cp .env.production.example .env
nano .env
```

Fill in every value (the file explains each one). To make the two secrets:

```bash
openssl rand -hex 24     # use for POSTGRES_PASSWORD
openssl rand -hex 32     # use for SECRETS_KEY
```

> **Keep `SECRETS_KEY` and `BACKUP_PASSPHRASE` somewhere safe outside the server** (a password manager).
> `SECRETS_KEY` unlocks your saved Google sign-ins; without it you'd have to reconnect both Drives. Without
> `BACKUP_PASSPHRASE` an encrypted database backup can't be restored.

`.env` holds passwords. Never commit it, email it or paste it into a chat.

## 6. Start it

```bash
docker compose up -d
docker compose ps
```

The first start downloads what it needs and takes a few minutes. When `docker compose ps` shows the
services running, open `https://archive.yourchurch.org`. The certificate is arranged automatically.

## 7. Download the transcription model (one time)

The worker never downloads anything on its own. Do this once, on purpose (about 1.5 GB for `medium`):

```bash
docker compose run --rm worker python -m sermon_worker.fetch_model medium
docker compose restart worker
```

`medium` is a good balance on an ordinary server. Use `large-v3` (about 3 GB, more accurate, about twice as
slow) by downloading it the same way and setting `WHISPER_MODEL=large-v3` in `.env`. On a server with no
graphics card, transcription runs at roughly the speed of the recording, so a 40-minute tape takes around
40 minutes. That's fine for a few tapes a week, but a backlog of hundreds is much faster on a Mac with an
M-series chip. See "Running the worker on a Mac" below.

## 8. Create the first admin

```bash
docker compose exec web node dist/create-admin.mjs --email you@yourchurch.org --name "Your Name"
```

It prints a one-time sign-in link. Open it, press **Sign in**, and you're in as an administrator.

## 9. Set it up in the app

1. **Settings:** enter your church's name and the default speaker.
2. **Team & access:** add the people who will upload and review tapes.
3. **Connections:** press **Connect Google Drive** for the shared drive, signing in with the first Google
   account, then for the backup with the second. The page confirms both, and lists any file that later
   changes.
4. **Try one tape** before the whole archive: upload it, wait for it to reach _Needs review_, check the title,
   summary and passages, then approve it. Confirm it shows as _Filed_ and the files appear in both Drives.

## Keeping it running

- **Updating:**
  ```bash
  cd sermon-archive && git pull
  cd deploy && docker compose pull && docker compose up -d
  ```
  Database changes are applied automatically at each start.
- **Backups:** every night the app's records are copied to your bucket (kept 14 days, plus each Sunday's for
  8 weeks). The **Connections** page shows when the last one happened and warns if one is missed. See
  [RESTORE.md](RESTORE.md) for getting them back.
- **Looking at what's happening:** `docker compose logs -f worker` (or `web`, `backup`).
- **Stopping and starting:** `docker compose down` and `docker compose up -d`. Your data is kept.
- **Disk space:** the server keeps the database and the transcription model. Recordings live in the bucket.

## Running the worker on a Mac instead

Transcription is much faster on an Apple-silicon Mac (a 40-minute tape in about 3 minutes). You can keep the
website on the server and run only the worker on the Mac:

1. On the server, stop the built-in worker: `docker compose up -d --scale worker=0`.
2. Connect the two machines privately, for example with the free Tailscale app on both, and add
   `-f compose.remote-worker.yaml` to your `docker compose` commands with `POSTGRES_BIND=<the server's Tailscale IP>`
   in `.env`, so the database is reachable only over that private link, never the public internet.
3. On the Mac, follow `worker/README.md` (`TRANSCRIBER=mlx`) with `DATABASE_URL` pointing at the server's
   Tailscale address and the same bucket settings.

## If something goes wrong

- **The site doesn't load:** wait a few minutes after the first start, check the domain's A record, and run
  `docker compose logs caddy`.
- **Sign-in emails don't arrive:** check `docker compose logs web` for mail errors, and your sender's SPF/DKIM.
- **A tape says "The transcription model is not installed":** do step 7.
- **A tape fails with a message:** open it. The message says what to fix, and Retry is on the page.
- **Google says "access blocked":** add the account as a test user (step 4.3) or publish the consent screen.
