#!/bin/sh
# Stops the worker service and removes it from this Mac's startup.
set -eu
launchctl bootout "gui/$(id -u)/com.sermonarchive.worker" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.sermonarchive.worker.plist"
echo "Removed."
