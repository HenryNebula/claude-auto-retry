#!/usr/bin/env bash
# Host-side driver: build the image once, then run the E2E with the repo mounted
# read-only at /app — code changes take effect without a rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=claude-auto-retry-e2e
docker build -t "$IMAGE" -f e2e/Dockerfile e2e/ >/dev/null
exec docker run --rm -v "$PWD:/app:ro" --name claude-auto-retry-e2e "$IMAGE"
