// Mock Anthropic API for the E2E harness. Serves two modes driven by a state file the
// orchestrator rewrites, so the "limit resets" moment is scripted without touching the
// running server:
//
//   {"mode":"ok"}                                                          — every request succeeds
//   {"mode":"limited","resetWall":"2026-09-28 06:03:10","resetUtcMs":179…} — 429 with the
//        provider-shaped rate-limit banner carrying resetWall (provider wall clock), and
//        requests succeed again once now >= resetUtcMs (the limit "clears" itself, like
//        the real rolling window does).
//
// The 429 body replicates the custom-provider render the incident was built from:
//   "Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will
//    reset at <resetWall>][<tag>]"
// where <tag> is the request time in the PROVIDER's clock (UTC+8, like the real gateway).
// That tag is what tz-calibration reads: tag − entry-UTC-timestamp = +480 min.
//
// `style` in the state file selects the provider whose banner shape is replayed (the
// monitor must handle each through a DIFFERENT mechanism):
//   zai (default) — the ISO + provider-tag shape above (rejoin/completion/calibration)
//   openai        — OpenAI-compat TPM wording with a RELATIVE-seconds clause; the seconds
//                   count down as the real gateway's would (recomputed per request)
//   kimi          — Moonshot's plan limit, which names NO reset time at all and is
//                   phrased as an overload; detection is only possible through a config
//                   limitPatterns entry the orchestrator seeds before launch
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 8082);
const STATE_FILE = process.env.MOCK_STATE_FILE || '/tmp/mock-state.json';
const LOG_FILE = process.env.MOCK_LOG_FILE || '/tmp/mock-api.log';
const PROVIDER_TZ_OFFSET_MS = 8 * 3600_000;   // the provider reports wall clock at UTC+8

let replies = 0;

function log(evt) {
  const line = `${new Date().toISOString()} ${evt}`;
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { mode: 'ok' }; }
}

function providerTag() {
  // YYYYMMDDHHmmss in the provider's wall clock + hex suffix, like the real gateway.
  const d = new Date(Date.now() + PROVIDER_TZ_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const tag = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${tag}e2e0000f67d4517`;
}

function limited(state) {
  return state.mode === 'limited' && Date.now() < state.resetUtcMs;
}

// The 429 error.message per provider style. Claude Code renders
// "● API Error: Request rejected (429) · <message>" — the prefix is ITS text, so each
// body starts where the provider's own message starts.
function limitedMessage(state) {
  switch (state.style) {
    case 'openai': {
      // A real TPM window counts down; so does ours (recomputed at each request, so the
      // terminal banner Claude Code finally renders carries the remaining seconds).
      const secsLeft = Math.max(1, Math.ceil((state.resetUtcMs - Date.now()) / 1000));
      return `Rate limit reached for claude-sonnet-5 in organization org-e2e on tokens `
        + `per min (TPM): Limit: 30000, Used: 29999, Requested: 221. `
        + `Please try again in ${secsLeft}s.`;
    }
    case 'kimi':
      return 'The engine is currently overloaded, please try again later';
    default:
      return `[1308][Usage limit reached for 5 hour. `
        + `Your limit will reset at ${state.resetWall}][${providerTag()}]`;
  }
}

function sseBody(text) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n');
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const state = readState();

    if (req.url.includes('/count_tokens')) {
      log(`POST ${req.url} → 200 count_tokens`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 16 }));
      return;
    }

    if (!req.url.includes('/v1/messages')) {
      log(`${req.method} ${req.url} → 200 passthrough`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    if (limited(state)) {
      const message = limitedMessage(state);
      log(`POST /v1/messages → 429 limited (style ${state.style || 'zai'})`);
      // Retry-After: 1 keeps Claude Code's internal attempt-N/10 loop short (a real
      // gateway would send the true wait; the harness needs the TERMINAL banner to
      // render within seconds so the monitor has the full window to work against).
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }));
      return;
    }

    replies += 1;
    const text = `e2e-mock-reply-${replies}`;
    const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
    log(`POST /v1/messages → 200 ok ${wantsStream ? '(stream)' : '(json)'} #${replies}`);
    if (wantsStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody(text));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_e2e', type: 'message', role: 'assistant', model: 'mock',
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 4 },
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => log(`mock api listening on 127.0.0.1:${PORT}`));
