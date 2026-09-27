# E2E harness: real Claude Code TUI + tmux + claude-auto-retry against a mock API.
# The repo itself is volume-mounted at /app at run time (see e2e/run.sh), so code edits
# don't need a rebuild — only the toolchain below does.
FROM node:22-bookworm-slim

# tmux: the surface the monitor drives. procps: `ps` for the foreground checks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

# Pinned so a Claude Code TUI change can't silently reshape the banners under test.
RUN npm install -g @anthropic-ai/claude-code@2.1.220

WORKDIR /workspace
ENV TERM=xterm-256color
CMD ["/bin/bash", "/app/e2e/run-e2e.sh"]
