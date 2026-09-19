"""Downloads a Whisper model on purpose. Nothing else in the worker downloads anything.

    python -m sermon_worker.fetch_model large-v3                       (CPU engine)
    python -m sermon_worker.fetch_model mlx-community/whisper-large-v3-turbo   (Mac GPU engine)

Models are cached in the Hugging Face cache (~/.cache/huggingface). large-v3 is about 3 GB.
"""

from __future__ import annotations

import sys


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("Usage: python -m sermon_worker.fetch_model <model-name>", file=sys.stderr)
        return 2
    name = argv[0]
    print(f"Downloading {name} ...")
    if "/" in name:
        # A Hugging Face repo, such as an MLX model.
        from huggingface_hub import snapshot_download

        path = snapshot_download(name)
        print(f"Model is at {path}")
        print(f"Set TRANSCRIBER=mlx and MLX_MODEL={name} to use it.")
    else:
        from faster_whisper.utils import download_model

        path = download_model(name)
        print(f"Model is at {path}")
        print(f"Set WHISPER_MODEL={name} (or WHISPER_MODEL_PATH={path}) to use it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
