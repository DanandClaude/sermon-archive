"""Starts the worker:  worker/run.sh   (add --once to process what is queued and exit)."""

from __future__ import annotations

import signal
import sys
import threading

from . import queue
from .analyzers import make_analyzer
from .config import REPO_ROOT, ConfigError, from_env, load_env_file
from .runner import Runner
from .store import make_store
from .transcribe import make_transcriber


def main(argv: list[str]) -> int:
    once = "--once" in argv
    load_env_file(REPO_ROOT / ".env.local")
    try:
        config = from_env()
    except ConfigError as error:
        print(f"Configuration problem: {error}", file=sys.stderr)
        return 2

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    store = make_store(config)
    transcriber = make_transcriber(config)
    analyzer = make_analyzer(config)
    info = {
        "host": config.worker_id,
        "store": "s3" if config.real_mode else "local",
        "transcriber": transcriber.name,
        "analyzer": analyzer.name,
    }
    print(
        f"Sermon worker {config.worker_id} starting: store={info['store']} "
        f"transcriber={transcriber.name} source={config.transcribe_source} "
        f"analyzer={analyzer.name}",
        flush=True,
    )

    conn = queue.connect(config.database_url)
    heartbeat = queue.Heartbeat(
        config.database_url, config.worker_id, config.heartbeat_seconds, info
    )
    heartbeat.start()
    queued = queue.reconcile_analysis(conn)
    if queued:
        print(f"queued analysis for {queued} finished transcript(s)", flush=True)
    runner = Runner(conn, config, store, transcriber, heartbeat=heartbeat, analyzer=analyzer)
    try:
        if once:
            while not stop.is_set() and runner.run_once():
                pass
        else:
            runner.run_forever(stop.is_set, sleep=lambda s: stop.wait(s))
    finally:
        heartbeat.stop()
        conn.close()
    print("Sermon worker stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
