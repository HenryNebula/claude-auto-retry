#!/usr/bin/env bash
# Host-side driver: build the image once, then run the E2E with the repo mounted
# read-only at /app — code changes take effect without a rebuild.
#
# E2E_STYLE picks the provider banner under test (zai | openai | kimi):
#   E2E_STYLE=openai npm run test:e2e
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=claude-auto-retry-e2e
STYLE="${E2E_STYLE:-zai}"
docker build -t "$IMAGE" -f e2e/Dockerfile e2e/ >/dev/null
exec docker run --rm -e E2E_STYLE="$STYLE" -v "$PWD:/app:ro" \
  --name "claude-auto-retry-e2e-$STYLE" "$IMAGE"
