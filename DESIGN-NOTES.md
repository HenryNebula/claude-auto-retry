# Design notes

Forward-looking design notes for `claude-auto-retry`, grounded in a research pass
(2026-06) against the installed Claude Code binary (v2.1.195, decompiled), the
Anthropic API error schema, and Claude Code's hooks/transcript surfaces. Ordered by
leverage. Items marked **[done]** ship in the current version; the rest are proposals
with enough detail to execute.

## 0. The core problem: we scrape a human-facing render

The overload path detects a *terminal* API error by scraping `tmux capture-pane` and
string-matching. That is fundamentally a heuristic over output meant for humans, and
every false positive we've hit (a `res.status(503)` under edit, an HTTP status code in
tool output in scrollback) and every false negative we worry about is a symptom of that
layer choice.
The hardening below makes the scraper as good as a scraper can be — but the strategic
move is to stop using the scrape as the *trigger*.

### Verified ground truth (informs everything else)

- **Two render forms, opposite meaning.** Terminal (retries exhausted):
  `API Error: <code> <body>` (colon form). Transient (still retrying):
  `API Error (<code> …) · Retrying in 5s · attempt 3/10` (parens, and/or a `· Retrying`
  suffix on the colon form). Acting on the transient form interrupts Claude's *own*
  backoff. **[done]** — we require the colon form and suppress the retry suffix via the
  working gate.
- **Error → HTTP status → retryability.** Retryable (seconds-scale): `500 api_error`,
  `504 timeout_error`, `529 overloaded_error`, plus edge `502/503`
  (no JSON body — plain text/HTML from Cloudflare/envoy, e.g. `503 no healthy upstream`).
  `429 rate_limit_error` is NOT event-retryable: on a subscription it is the session/usage
  limit — an hours-scale wait owned by the scraper usage path, not a seconds-scale retry.
  Never retry: `400/401/402/403/404/413`. The official SDK retry set is `408/409/429 +
  all 5xx`. **[done]** — default patterns cover `429|500|502|503|504|529` + `overloaded_error`.
- **API-429 has no 3-digit code in the slot.** It renders
  `API Error: Server is temporarily limiting requests (not your usage limit) · Rate
  limited`. A code-keyed matcher misses it. **[done]** — phrase pattern added.
- **529 is global capacity, not per-key.** Naive fixed backoff makes every client
  resynchronize into the same overload window → use **full jitter**. See §3.
- **Streaming caveat.** An error after a 200 (SSE `error` event) bypasses HTTP status.
  Claude streams, so a mid-response overload may render differently than a pre-flight
  failure. Not currently special-cased; low observed frequency.

## 1. Replace the trigger with `StopFailure` (highest leverage) — **[done, v0.4.0]**

**Implemented.** The launcher stamps `CLAUDE_AUTO_RETRY_PANE` onto claude's env; the
`StopFailure` hook (`claude-auto-retry _stopfailure-hook`, installed via
`install-hook`) runs as a claude child, inherits that var, and writes a pane-keyed
marker under `~/.claude-auto-retry/events/` for the transient-overload error types
(`overloaded|server_error` — `rate_limit` is deliberately excluded: it is the hours-scale
session/usage limit, owned by the scraper usage path; see src/events.js). The monitor
reads the marker for its own pane
each tick; the first marker latches `eventMode`, which disables the scraper for that
session. Edge-triggered: one backoff-then-send per failure, then back to monitoring;
self-recovery and foreground/shell gates still apply; the cumulative cap is shared with
the scraper path. The scraper remains the fallback until a marker is ever seen (hook
absent, pre-`v0.4.0` session without the pane env, or non-tmux).

**Correlation correction (learned during build):** the original plan resolved the
session via `/proc/<pid>/environ` → `CLAUDE_CODE_SESSION_ID`. In practice the *main*
claude PID's environ carries `CLAUDE_CONFIG_DIR` but **not** the session id (that var is
injected only into claude's child processes). Pane-keying via the launcher-stamped env
sidesteps this entirely and needs no `/proc` access (so it also works off-Linux).
Residual caveat: a recycled tmux pane id could in principle replay a stale marker —
bounded by `eventMaxAgeSeconds` (default 120) and consume-on-read.

### Original design (retained for reference)

Claude Code has a **`StopFailure` hook** that fires *only* when a turn ends due to an
API error, with a typed `error_type` matcher (`overloaded`, `server_error`,
`rate_limit`, `authentication_failed`, …). This is the zero-ambiguity signal: no
scraping, no terminal-vs-transient guessing, no self-referential false positive.

Constraint: `StopFailure` is **observability-only** — its output/exit code are ignored,
and hooks cannot inject a prompt or run `/`-commands. So it can detect but not actuate.
The daemon is the opposite (it owns the pane via `send-keys` but can't cleanly detect).
Pair them:

```
StopFailure hook  ──writes marker (error_type, session_id, transcript_path)──▶  daemon
                                                                                  │
                                       maps session_id/pane ──▶ tmux send-keys ◀──┘
```

- Hook handler (`type: command`) reads JSON on stdin, appends a marker file under a
  known dir (or a FIFO/socket). It does **not** retry.
- Daemon watches for markers, maps to the pane (it already owns the pane; or resolves
  via `CLAUDE_CODE_SESSION_ID`), applies the existing backoff + foreground-safety +
  cap logic, and sends the retry.
- Install per config dir — if you run more than one `CLAUDE_CONFIG_DIR`, repeat for each;
  hooks live in each `settings.json` under `hooks.StopFailure`.

**Verified against the installed v2.1.195 binary (2026-06).** `StopFailure` exists as a
real event with a dedicated `executeStopFailureHooks` path (separate from normal `Stop`),
and all nine matcher error types are present (`overloaded`, `server_error`, `rate_limit`,
`authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`,
`model_not_found`, `max_output_tokens`). The payload is built as:

```js
hookInput = { hook_event_name: "StopFailure", error, error_details, last_assistant_message }
//   the matcher filters on `error` (the type string)
```

plus the standard envelope (`session_id`, `transcript_path`, `cwd`). So a matcher of
`overloaded|server_error` selects exactly the transient-overload classes (`rate_limit`
is excluded — a session/usage limit is not an overload; see src/events.js), and the
handler gets the error type for free — no scraping. **The blocker is cleared; this
direction is ready to build.** It supersedes the scraper for the overload path; the
scraper stays as a legacy fallback for users who won't install hooks. Remaining
nice-to-have: a live forced-error run to capture the literal stdin JSON verbatim (the
field names above are read from the binary, not from a captured invocation).

## 2. JSONL-tail fallback (no hooks required)

If hooks aren't installed, tail the session transcript instead of the terminal. Claude
Code writes append-only JSONL at
`$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`. A turn that ends in a
retryable API error is written as a `type:"assistant"` record with the structured field
**`isApiErrorMessage: true`**. Fire only on that field in the **last** record — never
substring-grep the body (the body contains `overloaded_error`/`API Error` as ordinary
content in any session that discusses errors; grepping it reproduces the original bug).

Pane→transcript mapping (verified): `pane → claude PID → /proc/<pid>/environ →
$CLAUDE_CONFIG_DIR + CLAUDE_CODE_SESSION_ID` (filename == sessionId). Normal completion
is `message.stop_reason ∈ {end_turn, tool_use, stop_sequence}`; the error path writes no
successful assistant message. This is strictly lower-ambiguity than scraping and only
slightly more plumbing.

## 3. Backoff: full jitter for 529

Current jitter is proportional (`base × (1 ± jitterPct%)`). For global-overload 529 the
operational consensus is **full jitter** — `random(0, base)` — so a fleet of clients
running this tool doesn't resynchronize into the same overload window. Single-client
impact is small; ecosystem impact is real. Proposed: add `jitterMode: 'proportional' |
'full'` (default `proportional` to preserve current behavior, or flip to `full` for the
overload block specifically). Honor a `retry-after` header as a *floor* if/when we have
access to it (we don't, via scraping — another point for §1/§2). Low risk, ~15 lines.

## 4. Observability: log *why* **[done]**

The original bug logged `Overload detected` with no reason; diagnosing it required
reconstructing the pane. The monitor now logs the matched pattern and the offending
line (`overloadMatch`). Keep this discipline for any future detector — a detector that
can't say *why* it fired is undebuggable in the field.

## 5. Operational lifecycle: `ps` / `stop`, and no pile-ups

This session accumulated **four** detached `monitor.js` processes across launches, some
watching reused pane IDs — diagnosing required `pgrep`/`kill` by hand. Gaps:

- **No `claude-auto-retry ps` / `stop`.** Add both (list running monitors with pane +
  watched PID + status from logs; stop one or all). Pure operability win.
- **Pane-ID reuse.** tmux recycles pane IDs. A monitor whose pane closed and whose ID
  was reassigned could `send-keys` into the wrong pane. The PID-liveness check bounds
  this (monitor exits when its `claude` dies), but there's a window. Mitigation: each
  tick, re-verify the watched PID still maps to the target pane before sending.
- **Faster self-exit.** Monitor exits after 10 consecutive capture errors (~50s). Tighten,
  or exit immediately when `capture-pane` reports the pane is gone.
- **Single supervisor (larger):** replace per-launch detached forks with one supervisor
  that maintains a pane→PID registry and dedupes. Eliminates pile-ups structurally.

## 6. Send-keys safety: don't corrupt a half-typed prompt

`send-keys <text> Enter` fires whenever the foreground check passes — even if the user
is mid-typing in the prompt box. The foreground gate doesn't catch this. Cheap guard:
before sending, confirm the input box is empty (the captured prompt line is just the
prompt glyph). Imperfect via scraping; clean via the §1 architecture (act on the
StopFailure event, when the turn has definitively ended).

## 7. Confirm before acting (2-tick debounce)

A capture taken mid-render could momentarily show a colon-form error before the retry
suffix paints. The retry-suffix gate handles most of this; a belt-and-suspenders
**N-consecutive-captures** confirmation before the first send would close the race
entirely. Adds a small counter to state; ~10 lines. Worth it if §1 isn't adopted.

## 8. Print-mode parity

`launchPrintMode` retries on usage limits but not overload. A `-p` run that hits a
sustained 529 exits non-zero with `API Error: …` on stderr (and, with
`--output-format json`, `is_error:true` / `subtype:"error_during_execution"`). The
wrapper could apply the same overload backoff in print mode by inspecting the exit
code + stderr. Modest, self-contained.

## 9. Golden-capture test corpus

Current tests use synthetic strings. Capture **real** panes for each error type (529
json + collapsed, 500, 503 edge, the transient retry frame, API-429) as golden files
and assert detection against them. Makes the suite trustworthy against render drift,
and gives a regression anchor when Claude Code changes its output.

## Residual false positive (accepted, documented)

Because detection string-matches the render, a live tail that literally contains
`API Error: <code>` in prose or code (editing *this* repo's tests/README, or
documenting Claude error handling) will fire. There is no way to both match the real
terminal error and not match its literal text. Tail-anchoring bounds it to the last 12
lines; the escape hatch is `overload.enabled: false` while developing on the tool. §1/§2
remove this class entirely by keying on a structured field instead of the render.

## Suggested order

1. Verification spike for `StopFailure` (gates the whole §1 direction). Cheap, decisive.
2. If it fires: build §1 (hook + marker + daemon actuator). If not: build §2 (JSONL tail).
3. `ps`/`stop` + lifecycle hardening (§5) — independent, ship anytime.
4. Full jitter (§3), 2-tick debounce (§7), print-mode parity (§8) — small, independent.
5. Golden corpus (§9) alongside whichever detector becomes primary.

## Appendix: the background-session daemon protocol (2026-09-27)

Reverse-engineered facts the `bg` commands rely on, extracted from the Go reference
[kvaps/claude-agents-mcp](https://github.com/kvaps/claude-agents-mcp) (Apache-2.0)
and confirmed against the live daemon on this machine. All frames are
newline-delimited JSON over the unix socket `/tmp/cc-daemon-<uid>/<instance>/control.sock`
(freshest instance mtime wins; re-resolve per call — the instance dir rotates across
daemon restarts):

- `{"proto":1,"op":"list"}` → `{ok, error, jobs:[…]}` — unauthenticated. Each job:
  `short` (8-hex worker id), `sessionId`, `pid`, `cwd`, `name`, `state`
  (running|working|blocked|done), `tempo` (idle|active|blocked), `detail`, `needs`.
  **`needs` on a rate-limited job carries the whole provider banner verbatim** — the
  full reset datetime, unwrapped by any terminal width. This is a better detection
  source than the pane screen; it feeds `parseLimitReset` unchanged.
- `{"proto":1,"op":"subscribe","short":S,"tail":N}` — unauthenticated, read-only;
  first `type:"snapshot"` frame carries `{record, streamTail:[lines]}` (the screen).
- `{"proto":1,"op":"reply","short":S,"text":T,"auth":K}` → `{ok, error, code}` —
  authenticated with `~/.claude/daemon/control.key` (32 bytes, trimmed). Submits T
  AS A TURN to the live worker — the same path the `claude` CLI uses to message a
  background session. Codes: `ESTARTING`/`ENOREPLY` transient (retry ~200ms, ≤12x),
  `EAUTH` daemon rotated the key (re-read once), `ENOJOB` worker gone.

Semantics that matter to the wait loop: `state:"working"` means a turn is in flight
(`tempo:"active"` alone does NOT — it only means recent output); leaving `blocked`
after a `reply` is the delivery verification. The dispatch op (spawning sessions) is
also authenticated; resuming exited sessions hits the CLI's resume dialog (default
option compacts!) and is deliberately out of scope — a rate-limited session is
live-but-blocked.

Stability: undocumented and version-coupled to Claude Code. The transport lives in
`src/bg-sessions.js` behind small functions precisely so a first-party verb
(`claude agents send`, if it ever ships) can replace it without touching detection
or wait logic. Related reading: Origin Technology's analysis of these sockets as a
security boundary (any local process can drive your background agents).
