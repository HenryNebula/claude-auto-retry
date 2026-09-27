// Client for Claude Code's background-session daemon — the `claude agents` /
// `claude --bg` fleet. Ported from kvaps/claude-agents-mcp (Go, Apache-2.0), the
// reference implementation of the reverse-engineered control protocol.
//
// The daemon listens on a per-user control socket (newline-framed JSON, one
// request line → one reply line):
//   /tmp/cc-daemon-<uid>/<instance>/control.sock
//     op:list      {proto:1, op:"list"} → {ok, error, jobs:[Job…]}   — unauthenticated
//     op:subscribe {proto:1, op:"subscribe", short, tail} → frames   — unauthenticated
//         (read-only screen: first frame type:"snapshot" carries {record, streamTail})
//     op:reply     {proto:1, op:"reply", short, text, auth} → {ok, error, code}
//         — AUTHENTICATED with ~/.claude/daemon/control.key; submits TEXT AS A TURN
//         to a running session (the same path the claude CLI uses to message a
//         background session), not keystrokes into its PTY. Codes: ESTARTING /
//         ENOREPLY are transient (retry), EAUTH means the daemon rotated its key
//         (re-read once), ENOJOB means the worker is gone.
//
// Why this exists here: the tmux monitors can only see a conversation while it is
// the one rendered in a watched pane. Daemon-hosted background sessions never
// render into a pane — but op:list reports structured state, and a blocked job's
// `needs` field carries the whole rate-limit banner verbatim (full reset datetime,
// unwrapped — better than the screen). Detection becomes data, and op:reply is the
// resume send. See bg-watch.js for the wait/send loop built on this.

import { createConnection } from 'node:net';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultClaudeConfigDir } from './tz-calibrate.js';

// A reply frame can be large (a screen snapshot); refuse to buffer without bound.
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

// Freshest control.sock for this user, or null when no daemon is running. Resolved
// on every call so a client survives daemon restarts (the instance dir changes).
// `uid` is injectable purely for tests; `tmpRoot` exists for the same reason.
export async function findControlSocket(tmpRoot = '/tmp', uid = process.getuid()) {
  const base = join(tmpRoot, `cc-daemon-${uid}`);
  let instances;
  try { instances = await readdir(base, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const inst of instances) {
    if (!inst.isDirectory()) continue;
    const sock = join(base, inst.name, 'control.sock');
    // A successful stat is enough — the entry IS the socket (isFile() is false for
    // sockets, so a type check here would exclude exactly what we want).
    const s = await stat(sock).catch(() => null);
    if (s && s.mtimeMs > (best?.mtimeMs ?? -1)) best = { path: sock, mtimeMs: s.mtimeMs };
  }
  return best ? best.path : null;
}

// Send one newline-framed JSON request and hand every complete reply LINE to
// onLine. Resolves with the value onLine returns (first truthy), rejects on
// socket error / timeout / oversized reply. One connection per request, like the
// reference client — the socket is cheap and this never holds a session open.
export function controlExchange(socketPath, payload, {
  timeoutMs = 5000, onLine = (line) => line,
} = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const sock = createConnection({ path: socketPath });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`control socket (${socketPath}) timed out after ${timeoutMs}ms`))),
      timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(payload)}\n`));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REPLY_BYTES) {
        finish(() => reject(new Error('control reply exceeded 8MB')));
        return;
      }
      let nl;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        const out = onLine(parsed);
        if (out !== undefined) finish(() => resolve(out));
      }
    });
    sock.on('error', (err) => finish(() => reject(err)));
    sock.on('close', () => finish(() => reject(new Error(`control socket (${socketPath}) closed before replying`))));
  });
}

// Normalize a daemon job record to the fields this package consumes (see the Go
// reference's Session type for the full vocabulary: state ∈ running | working |
// blocked | done; tempo ∈ idle | active | blocked; `needs` is what a blocked
// session is waiting on — for a rate limit, the whole banner).
export function normalizeJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    short: job.short || '',
    sessionId: job.sessionId || '',
    pid: job.pid ?? null,
    cwd: job.cwd || '',
    name: job.name || '',
    intent: job.intent || '',
    tempo: job.tempo || '',
    state: job.state || '',
    detail: job.detail || '',
    needs: job.needs || '',
    startedAt: job.startedAt ?? null,
  };
}

// Live daemon roster (op:list) — running workers only, no display names. Not-
// running (resumable) sessions need `claude agents --json --all`; deliberately
// out of scope: this package only drives LIVE sessions, and a rate-limited
// session is live-but-blocked.
export async function listBgSessions({ socketPath } = {}) {
  const sock = socketPath || await findControlSocket();
  if (!sock) throw new Error('no claude daemon control socket found — is `claude agents` running?');
  const resp = await controlExchange(sock, { proto: 1, op: 'list' });
  if (!resp || resp.ok !== true) {
    throw new Error(`daemon list failed: ${resp?.error || 'unparseable reply'}`);
  }
  return (Array.isArray(resp.jobs) ? resp.jobs : []).map(normalizeJob).filter(Boolean);
}

// Read a running session's screen as plain text (the PTY tail, joined). Read-only,
// unauthenticated — the same data `claude agents` attach renders.
export async function readBgScreen(short, { tail = 400, socketPath, timeoutMs } = {}) {
  if (!short) throw new Error('session is not running (no screen to read)');
  const sock = socketPath || await findControlSocket();
  if (!sock) throw new Error('no claude daemon control socket found — is `claude agents` running?');
  return controlExchange(sock, { proto: 1, op: 'subscribe', short, tail }, {
    timeoutMs,
    onLine: (frame) => {
      if (frame && frame.error) throw new Error(`daemon subscribe error: ${frame.error}`);
      if (frame && frame.type === 'snapshot') {
        return Array.isArray(frame.streamTail) ? frame.streamTail.join('') : '';
      }
      return undefined;   // keep reading frames until the snapshot arrives
    },
  });
}

// The daemon control key. `reply` (and dispatch) are authenticated; list and
// subscribe are not. Lives under the claude config dir (CLAUDE_CONFIG_DIR-aware,
// like every other path in this package).
export async function readControlKey(claudeConfigDir = defaultClaudeConfigDir()) {
  const raw = await readFile(join(claudeConfigDir, 'daemon', 'control.key'), 'utf8');
  const key = raw.trim();
  if (!key) throw new Error('daemon control key is empty');
  return key;
}

// Submit TEXT AS A TURN to a running background session — the resume send. Mirrors
// the reference Reply(): ESTARTING/ENOREPLY retried at 200ms (the worker is
// booting / momentarily not accepting input), EAUTH re-reads the key once (the
// daemon restarted and rotated it), any other code is an error. keyReader is
// injectable for tests.
export async function replyToBgSession(short, text, {
  socketPath, maxAttempts = 12, delayMs = 200, keyReader = readControlKey,
} = {}) {
  if (!short) throw new Error('session is not running (no reply target)');
  const sock = socketPath || await findControlSocket();
  if (!sock) throw new Error('no claude daemon control socket found — is `claude agents` running?');
  let key = await keyReader();
  let refreshedAuth = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await controlExchange(sock, { proto: 1, op: 'reply', short, text, auth: key });
    if (resp && resp.ok === true) return { ok: true };
    const code = resp?.code || '';
    if (code === 'ESTARTING' || code === 'ENOREPLY') {
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }
    if (code === 'EAUTH') {
      if (refreshedAuth) {
        throw new Error(`reply rejected (daemon control key mismatch): ${resp?.error || ''}`);
      }
      key = await keyReader();
      refreshedAuth = true;
      continue;
    }
    const err = new Error(`reply rejected: ${resp?.error || code || 'unknown'}`);
    err.code = code;
    throw err;
  }
  throw new Error(`session ${short} did not accept the prompt after ${maxAttempts} attempts`);
}
