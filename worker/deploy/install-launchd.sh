#!/bin/sh
# Installs the worker as a background service on this Mac: it starts at login and restarts if it
# stops. Undo with worker/deploy/uninstall-launchd.sh.
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$HOME/Library/LaunchAgents/com.sermonarchive.worker.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
  "$REPO/worker/deploy/com.sermonarchive.worker.plist.template" > "$DEST"
plutil -lint "$DEST"
launchctl bootout "gui/$(id -u)/com.sermonarchive.worker" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed. Log: ~/Library/Logs/sermon-worker.log"
