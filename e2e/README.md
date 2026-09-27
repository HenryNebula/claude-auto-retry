# E2E: real Claude Code TUI against a mock API

Replays the wrapped-banner incident end to end, in Docker, with a real pinned Claude Code
(`@anthropic-ai/claude-code@2.1.220`) TUI running inside tmux — no mocks of the monitor
or the TUI, only of the API behind `ANTHROPIC_BASE_URL`.

```
npm run test:e2e        # or e2e/run.sh — builds the image if needed, ~8 minutes
```

## What it proves (the incident, step by step)

1. **Phase 1 — a healthy turn.** A prompt round-trips against the mock (`e2e-mock-reply-1`).
2. **Phase 2 — the limit.** The mock flips to 429 mode with a reset ~6 minutes out,
   reported in the provider's wall clock (UTC+8, like the real gateway). Claude Code's
   internal attempt-10/10 retries burn for ~3 minutes, then the terminal banner renders.
3. **The wrap.** The pane is 120 columns — sized so the banner wraps exactly between the
   date and the clock (`… will reset at 2026-09-27` / `  07:41:36][tag]`), the shape the
   monitor mis-parsed into "today at 8pm" (~2h past the real reset) in production.
4. **The recovery.** The monitor's extraction rejoins the wrapped rows (primary fix); if
   that is ever impossible, the date-only parse is completed from the session JSONL's
   `isApiErrorMessage` entry (fallback), then tz-calibrated via the provider tag.
5. **The auto-resume.** The mock un-limits itself at the true reset (a rolling window
   clearing, not a script flip), and the monitor sends the retry at reset+margin —
   `Sent retry message (attempt 1)` lands within seconds of the computed wake, and the
   turn completes with **no manual continue anywhere**.

The run fails loudly (pane capture, monitor log, mock log, transcript list) at whichever
step breaks.

## Files

- `Dockerfile` — node 22 + tmux + pinned Claude Code. The repo is mounted read-only at
  `/app` at run time, so code changes don't need a rebuild.
- `mock-api.mjs` — the mock API: SSE/plain responses when healthy, the provider-shaped
  429 banner when limited (with a UTC+8 request tag for calibration), self-clearing at
  the reset.
- `run-e2e.sh` — the orchestrator (runs inside the container).
- `run.sh` — host-side driver: `docker build` + `docker run`.

Timing notes: the 6-minute reset exists to outlast Claude Code's ~3-minute internal
retry backoff (which ignores `Retry-After`) while keeping the run short. The wrap width
(120) is empirical — the TUI wraps error paragraphs at roughly `cols-4`; if a Claude Code
update moves the wrap point, the harness fails at the wrap assertion with the pane dump
on screen, and the width is the knob.
