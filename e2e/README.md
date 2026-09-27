# E2E: real Claude Code TUI against a mock API

Replays provider rate-limit banners end to end, in Docker, with a real pinned Claude Code
(`@anthropic-ai/claude-code@2.1.220`) TUI running inside tmux — no mocks of the monitor
or the TUI, only of the API behind `ANTHROPIC_BASE_URL`.

```
npm run test:e2e                      # zai (default) — ~8 minutes
E2E_STYLE=openai npm run test:e2e     # OpenAI-compat TPM banner
E2E_STYLE=kimi   npm run test:e2e     # Kimi plan-limit banner (config-taught detection)
```

## The three provider styles

| Style | Banner the mock emits | Mechanism under test |
|---|---|---|
| `zai` (default) | `[1308][Usage limit reached for 5 hour. Your limit will reset at <UTC+8 wall clock>][<tag>]` | wrapped-banner rejoin → JSONL clock completion → provider-tag tz calibration |
| `openai` | `Rate limit reached for <model> … Please try again in <N>s.` (N counts down per request, like a real TPM window) | built-in limit + relative-**seconds** clauses; wait = N + margin |
| `kimi` | `The engine is currently overloaded, please try again later` — names **no** reset time | a `limitPatterns` config entry the orchestrator seeds (`requireReset:false`, `limitHours:0.09`); detection is impossible without it |

## What a run proves (the incident, step by step)

1. **Phase 1 — a healthy turn.** A prompt round-trips against the mock (`e2e-mock-reply-1`).
2. **Phase 2 — the limit.** The mock flips to 429 mode with a reset ~6 minutes out,
   reported in the provider's wall clock (UTC+8, like the real gateway). Claude Code's
   internal attempt-10/10 retries burn for ~3 minutes, then the terminal banner renders.
3. **The wrap** (`zai` only). The pane is 120 columns — sized so the banner wraps exactly
   between the date and the clock (`… will reset at 2026-09-27` / `  07:41:36][tag]`),
   the shape the monitor mis-parsed into "today at 8pm" (~2h past the real reset) in
   production. The other styles run at 220 columns — they test vocabulary and parsing,
   not wrapping.
4. **The recovery.** `zai`: the extraction rejoins the wrapped rows (primary fix); if
   that is ever impossible, the date-only parse is completed from the session JSONL's
   `isApiErrorMessage` entry (fallback), then tz-calibrated via the provider tag.
   `openai`: the seconds clause parses relative. `kimi`: the config entry detects, and
   its `limitHours` caps the fallback wait (~324s, not the 5h default).
5. **The auto-resume.** The mock un-limits itself at the true reset (a rolling window
   clearing, not a script flip), and the monitor sends the retry at reset+margin —
   `Sent retry message (attempt 1)` lands within seconds of the computed wake, and the
   turn completes with **no manual continue anywhere**.

The run fails loudly (pane capture, monitor log, mock log, transcript list) at whichever
step breaks.

## Files

- `Dockerfile` — node 22 + tmux + pinned Claude Code. The repo is mounted read-only at
  `/app` at run time, so code changes don't need a rebuild.
- `mock-api.mjs` — the mock API: SSE/plain responses when healthy, the style-selected
  provider 429 banner when limited (with a UTC+8 request tag for calibration), 
  self-clearing at the reset.
- `run-e2e.sh` — the orchestrator (runs inside the container; reads `E2E_STYLE`).
- `run.sh` — host-side driver: `docker build` + `docker run`, forwards `E2E_STYLE`.

Timing notes: the 6-minute reset exists to outlast Claude Code's ~3-minute internal
retry backoff (which ignores `Retry-After`) while keeping the run short. The wrap width
(120) is empirical — the TUI wraps error paragraphs at roughly `cols-4`; if a Claude Code
update moves the wrap point, the harness fails at the wrap assertion with the pane dump
on screen, and the width is the knob. `kimi` runs longer (~12 min): its wake is the
entry-capped fallback from detection (~3 min in), so the retry deadline is extended.
