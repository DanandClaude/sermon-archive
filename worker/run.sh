#!/bin/sh
# Starts the worker (or any sermon_worker module) with the project's virtual environment.
# PYTHONPATH is set here because macOS can mark the editable-install .pth file as hidden, and
# Python then skips it.
#   worker/run.sh                      run the worker
#   worker/run.sh -m sermon_worker.fetch_model large-v3
cd "$(dirname "$0")" || exit 1
[ "$#" -eq 0 ] && set -- -m sermon_worker
exec env PYTHONPATH="src${PYTHONPATH:+:$PYTHONPATH}" .venv/bin/python "$@"
