# The audio worker and the backup service. Build from the repository root:
#   docker build -f worker/Dockerfile -t sermon-archive-worker .
# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

# ffmpeg for the audio; the PostgreSQL 16 client for backups (it must match the server's version).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl gnupg postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/pyproject.toml worker/pyproject.toml
COPY worker/src worker/src
COPY shared shared
RUN pip install --no-cache-dir ./worker

# Whisper models live in a volume so they survive updates. The worker never downloads one by itself;
# the install guide has a step for it.
ENV SHARED_DIR=/app/shared HF_HOME=/models PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 worker && mkdir -p /models && chown worker /models
USER worker
VOLUME ["/models"]
CMD ["python", "-m", "sermon_worker"]
