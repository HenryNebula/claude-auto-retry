#!/usr/bin/env bash
# E2E: the wrapped-banner incident, replayed against a real Claude Code TUI.
#
# Timeline:
#   1. claude (pinned version) runs in a 120-column tmux pane — sized so the provider's
#      long 429 banner wraps exactly between the date and the clock, the shape the
#      monitor mis-parsed for ~2h in production.
#   2. Prompt 1 succeeds against the mock API.
#   3. The mock flips to limited with a reset ~6 minutes out (provider wall clock UTC+8).
#   4. Prompt 2 hits the 429 → wrapped banner → the monitor scrapes a DATE-ONLY reset.
#   5. The completion fallback reads the full datetime from the session JSONL, tz
#      calibrates via the provider tag, and waits to the true reset + margin.
#   6. At the reset the mock un-limits itself; the monitor auto-sends the retry and the
#      turn succeeds — with NO manual continue anywhere.
set -euo pipefail

APP=/app
SESSION=e2e
PANE="${SESSION}:0.0"
MOCK_LOG=/tmp/mock-api.log
MONITOR_LOG_DIR=/root/.claude-auto-retry/logs
STATE=/tmp/mock-state.json
PROJ=/workspace/proj
RESET_IN_MS=$((6 * 60 * 1000))     # true reset: 6 min out — past Claude Code's ~3-min
                                   # internal attempt-N/10 backoff, so the terminal
                                   # banner renders while the limit is still live

export TERM=xterm-256color
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
export ANTHROPIC_AUTH_TOKEN=e2e-mock-token
export ANTHROPIC_MODEL=claude-sonnet-5
export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
export CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export SHELL=/bin/bash

fail() {
  echo "FAIL: $*" >&2
  echo "=== pane (last 60 lines) ==="; tmux capture-pane -p -t "$PANE" -S -60 2>&1 | tail -60
  echo "=== monitor log ==="; tail -30 "$MONITOR_LOG_DIR"/*.log 2>&1
  echo "=== mock log ==="; tail -20 "$MOCK_LOG" 2>&1
  echo "=== transcripts ==="; ls -la /root/.claude/projects/*/ 2>&1 | tail -10
  exit 1
}

capture() { tmux capture-pane -p -t "$PANE" -S -"${1:-30}"; }

wait_for() {  # wait_for <text> <timeout_s> <grep-target: pane|monitor|mock>
  local text=$1 timeout=$2 where=${3:-pane} elapsed=0 deadline line
  [ "$where" = monitor ] && line=$(ls "$MONITOR_LOG_DIR"/*.log | tail -1) || true
  while [ $elapsed -lt $timeout ]; do
    case $where in
      pane)    capture 60 | grep -qF "$text" && return 0 ;;
      monitor) grep -qF "$text" "$line" 2>/dev/null && return 0 ;;
      mock)    grep -qF "$text" "$MOCK_LOG" 2>/dev/null && return 0 ;;
    esac
    sleep 2; elapsed=$((elapsed + 2))
  done
  return 1
}

echo "== seeding config =="
mkdir -p "$PROJ"
cat > /root/.claude.json <<'EOF'
{"numStartups": 3, "hasCompletedOnboarding": true, "theme": "dark",
 "bypassPermissionsModeAccepted": true, "autoUpdaterStatus": "disabled"}
EOF

echo "== starting mock api =="
node "$APP/e2e/mock-api.mjs" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
echo '{"mode":"ok"}' > "$STATE"
for i in $(seq 1 20); do
  node -e "fetch('http://127.0.0.1:8082/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 0.5
done
grep -q 'listening' "$MOCK_LOG" || fail "mock api did not start"

# 120 cols: the TUI's usable width (~cols-4) lands the banner's date at end-of-row
# and the clock on the continuation row — the incident's date-only scrape.
echo "== launching claude in a 120-col pane (the wrap width) =="
cd "$PROJ"
tmux new-session -d -x 120 -y 30 -s "$SESSION" \
  "CLAUDE_AUTO_RETRY_ACTIVE=1 TERM=xterm-256color SHELL=/bin/bash node $APP/src/launcher.js"

# Ready = input box rendered. Handle first-run dialogs defensively (trust prompt, theme).
READY=0
for i in $(seq 1 60); do
  TXT=$(capture 40)
  if echo "$TXT" | grep -qE 'for shortcuts|╭.*╮.*>'; then READY=1; break; fi
  if echo "$TXT" | grep -qiE 'trust'; then tmux send-keys -t "$PANE" Enter; fi
  if echo "$TXT" | grep -qiE 'use this API key'; then tmux send-keys -t "$PANE" 1; tmux send-keys -t "$PANE" Enter; fi
  if echo "$TXT" | grep -qiE 'select (your )?theme|choose a theme'; then tmux send-keys -t "$PANE" Enter; fi
  sleep 1.5
done
[ "$READY" = 1 ] || fail "claude TUI never became ready"
echo "   TUI ready after ~$((i * 2))s"

echo "== phase 1: a working turn =="
tmux send-keys -t "$PANE" -l 'Say hi'
tmux send-keys -t "$PANE" Enter
wait_for 'e2e-mock-reply-1' 90 || fail "phase-1 reply never rendered"

echo "== phase 2: flip to limited, reset in 6 minutes =="
RESET_UTC_MS=$(( $(date +%s%3N) + RESET_IN_MS ))
RESET_WALL=$(node -e "
  const d = new Date($RESET_UTC_MS + 8 * 3600e3);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  process.stdout.write(\`\${d.getUTCFullYear()}-\${p(d.getUTCMonth()+1)}-\${p(d.getUTCDate())} \${p(d.getUTCHours())}:\${p(d.getUTCMinutes())}:\${p(d.getUTCSeconds())}\`);
")
echo "{\"mode\":\"limited\",\"resetWall\":\"$RESET_WALL\",\"resetUtcMs\":$RESET_UTC_MS}" > "$STATE"
echo "   reset wall clock (UTC+8): $RESET_WALL"

tmux send-keys -t "$PANE" -l 'Say hi again'
tmux send-keys -t "$PANE" Enter
# Wait for the TERMINAL banner, not the internal-retry spinner ("✻ 429 … · Retrying in
# 1s · attempt N/10") — the terminal render leads with "API Error:", the spinner never
# does. The attempt-10/10 loop with exponential backoff takes ~3 minutes.
wait_for 'API Error:' 300 || fail "the 429 banner never rendered"

echo "== asserting the banner wrapped between date and clock =="
WALL_DATE=${RESET_WALL%% *}          # YYYY-MM-DD
WALL_TIME=${RESET_WALL#* }           # hh:mm:ss
if ! capture 40 | grep -qE "reset at ${WALL_DATE}[[:space:]]*$"; then
  fail "banner did not wrap at the date (tune tmux -x); pane above"
fi
if ! capture 40 | grep -A1 "reset at ${WALL_DATE}[[:space:]]*$" | grep -qE "^[[:space:]]*${WALL_TIME}"; then
  fail "wrapped continuation does not lead with the clock; pane above"
fi
echo "   wrapped as in the incident: row 1 ends '${WALL_DATE}', row 2 leads '${WALL_TIME}'"

echo "== monitor: recovered the exact reset from the wrapped banner =="
wait_for 'Rate limit detected' 60 monitor || fail "monitor never detected the limit"
DETECT_LINE=$(grep 'Rate limit detected' "$MONITOR_LOG_DIR"/*.log | tail -1)
echo "$DETECT_LINE" | grep -qF "reset at $RESET_WALL" \
  || fail "extracted banner does not carry the full datetime $RESET_WALL (rejoin nor completion fired)"
# The wait must be the exact reset + margin — not the 5h fallback, not a mis-parsed hour.
WAIT_S=$(echo "$DETECT_LINE" | grep -oE 'Waiting [0-9]+s' | grep -oE '[0-9]+')
[ "${WAIT_S:-0}" -le 300 ] || fail "wait ${WAIT_S}s is not the exact reset (fallback or mis-parse)"
echo "   $DETECT_LINE"
if grep -q 'clock completed from session history' "$MONITOR_LOG_DIR"/*.log; then
  echo "   (date-only scrape was completed from session history)"
fi

echo "== waiting for the auto-resume at the true reset (no manual continue) =="
DEADLINE_MS=$(( RESET_UTC_MS + 60000 + 120000 ))     # reset + margin + slack
wait_for 'Sent retry message' 300 monitor || fail "monitor never sent the retry"
grep 'Sent retry message' "$MONITOR_LOG_DIR"/*.log | tail -1 | sed 's/^/   /'
# A numbered reply ≥2 rendered near the bottom = the auto-sent turn completed. (The
# retry may fire a main + an auxiliary request, so the visible reply number can be >2.)
RESUME_OK=0
while [ "$(date +%s%3N)" -lt "$DEADLINE_MS" ]; do
  N=$(capture 20 | grep -oE 'e2e-mock-reply-[0-9]+' | tail -1 | grep -oE '[0-9]+$')
  if [ -n "${N:-}" ] && [ "$N" -ge 2 ]; then
    echo "   auto-resumed turn completed at $(date -u +%H:%M:%S)UTC (reply #${N})"
    RESUME_OK=1; break
  fi
  sleep 5
done
[ "$RESUME_OK" = 1 ] || fail "the auto-retry turn never completed"

echo "== artifacts =="
JSONL=$(find /root/.claude/projects -name '*.jsonl' -mmin -30 2>/dev/null | head -1 || true)
[ -n "${JSONL:-}" ] && echo "   transcript: $JSONL ($(wc -l < "$JSONL") lines)"
echo "   monitor log: $(ls "$MONITOR_LOG_DIR"/*.log)"

tmux kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
echo "PASS: wrapped banner → full datetime recovered → auto-resumed at the true reset, no manual continue"
