#!/bin/bash
# Double-click in Finder to run the archive on this Mac: the website and the audio worker together.
# Close this window (or press Ctrl-C) to stop both.
cd "$(dirname "$0")" || exit 1

# Port and address come from APP_URL in .env.local, e.g. http://localhost:3100.
APP_URL=$(grep -E '^APP_URL=' .env.local 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
APP_URL=${APP_URL:-http://localhost:3000}
PORT=$(printf '%s' "$APP_URL" | sed -nE 's#.*:([0-9]+)/?$#\1#p')
PORT=${PORT:-3000}

if command -v brew >/dev/null && ! pg_isready -q 2>/dev/null; then
  echo "Starting the database…"
  brew services start postgresql@16 >/dev/null
  sleep 2
fi

echo "Starting the Sermon Archive at $APP_URL"
PORT=$PORT npm run dev &
if [ -x worker/.venv/bin/python ]; then
  npm run worker &
else
  echo "The audio worker isn't installed yet (npm run worker:install), so uploads will wait."
fi
trap 'trap - INT TERM HUP EXIT; kill 0 2>/dev/null' INT TERM HUP EXIT

for _ in $(seq 1 60); do
  curl -s -o /dev/null "$APP_URL" && break
  sleep 1
done
open "$APP_URL"
echo
echo "Running. Leave this window open; close it to stop the archive."
wait
