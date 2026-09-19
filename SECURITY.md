# Security

Sermon Archive holds people's names and email addresses and, once connected, sign-in tokens for Google
accounts. If you find a security problem, please **do not open a public issue**. Use GitHub's
"Report a vulnerability" button on the repository's Security tab so it can be fixed before it is discussed.

What the design already does, so you can check it:

- Sign-in is by emailed one-time link; links and sessions are stored only as hashes.
- Every page, action and API route checks permissions on the server, not just in the browser.
- Saved Google sign-ins are encrypted at rest (AES-256-GCM) with a key you set.
- Nothing is filed to a real Google account outside production mode.
- Files that are filed are never overwritten or deleted by the app.
