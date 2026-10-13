# Running the archive: a guide for admins

This guide assumes the app is installed (see `deploy/INSTALL.md`) and you've signed in as the first admin.

## Set up once

1. **Settings:** enter the church's name and the usual speaker. They appear on file names, YouTube and the
   podcast.
2. **Team & access:** use **Add someone** for each person.
   - **Contributors** upload and approve their own sermons.
   - **Viewers** can only browse approved ones.
   - **Admins** can do everything.

   Each person gets an email with a sign-in link. To remove someone, disable them and they're signed out at
   once.

3. **Connections:** connect the **shared archive drive** and the **admin backup**, each with its own Google
   account. Approved sermons are copied to both and checked after copying.
4. **Publishing (optional):** on **Connections**, connect YouTube and/or turn on the podcast feed. Give the feed
   link on that page to Apple Podcasts and Spotify.

## Every week or so

Open **System health**. It says either "Everything is working" or lists what needs attention, with a link to
fix each item:

- **Processing worker stopped:** the computer that transcribes is off or the worker isn't running. Uploads wait
  safely until it's back.
- **Database backup failed or is old:** check that the backup service is running (`docker compose ps`).
- **Files changed or missing in a drive:** someone edited or deleted a filed copy. The Connections page lists
  each file. Restore it from the other drive, which keeps its own copy.
- **Processing failed:** open the sermon. **Technical detail** shows the raw error for you. Contributors only
  see a plain message.

## Publishing a sermon

Open an approved sermon and press **Publish…**. The dialog shows exactly what YouTube gets: the title card,
title and description. You choose who can watch (Private, Unlisted or Public). Podcast episodes are always
public, and the first one asks you to confirm that.

The **Publishing** page shows everything waiting, live or failed. **Unpublish** makes a YouTube video private,
so it can be published again later; nothing is deleted from YouTube. It also takes an episode out of the
podcast feed. YouTube allows only a few uploads a day, so a backlog goes out over several days by itself.

## When someone reports a problem

- **"Something went wrong" pages** show a reference. Search the web log for it:
  `docker compose logs web | grep <reference>`.
- **A contributor approved something with a mistake:** open it and fix it. Admins can edit after approval.
  Fixes to an already filed sermon aren't copied to the drives again automatically.
