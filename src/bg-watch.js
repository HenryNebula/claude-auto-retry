// The usage-wait pipeline, driven against the background-session daemon instead
// of a tmux pane. Same discipline as monitor.js's waiting state, translated:
//   detection   op:list state:"blocked" — the job's `needs` field carries the
//               whole limit banner verbatim (unwrapped — better than the screen)
//   wait        usageWaitUntil() unchanged: findRateLimitMessage over `needs`,
//               parseLimitReset, tz calibration, the limitHours cap, the margin
//   send        replyToBgSession() — op:reply submits the retry message as a
//               TURN, no keystroke emulation, no foreground gates (no pane)
//   verify      the next op:list: a job that left "blocked" (working/done) had
//               its turn accepted; still-blocked re-enters the loop, bounded by
//               maxRetries like the pane path
//
// Deliberately NOT covered (yet): resuming exited sessions (the reference's
// resume-dialog machinery) — a rate-limited session is live-but-blocked, and a
// session that exited while limited is a fresh detection when it comes back.

import { listBgSessions, replyToBgSession } from './bg-sessions.js';
import { usageWaitUntil } from './monitor.js';
import { isRateLimited } from './patterns.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { open, readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BG_STATE_DIR = join(homedir(), '.claude-auto-retry', 'status');
const BG_STATE_FILE = join(BG_STATE_DIR, 'bg-watch.json');
const BG_LOCK_FILE = join(homedir(), '.claude-auto-retry', 'bg-watch.lock');
// A leader heartbeats every tick (bgWatch.tickSeconds, ≥15s); three missed
// heartbeats plus a dead-PID check make the lock stealable. Exported for tests.
export const BG_LOCK_STALE_MS = 90_000;
// After sending a retry, stand down at least this long: the daemon keeps a session
// flagged state:"blocked" (with an EMPTY needs) while the queued retry turn runs,
// which read as "still limited" and re-sent on every cooldown — observed live as
// three stacked "Continue where you left off." turns. The latch clears when the
// session LEAVES the blocked state (the agent came back), when the banner changes
// (a new limit episode re-arms from scratch), or when this window passes with the
// limit genuinely still up — a legitimate, attempts-bounded retry.
export const BG_SETTLE_MS = 10 * 60_000;

// Matches the pane monitor's tail discipline; `needs` is a single clean line, so
// the window is nominal — the vocabulary gate is what matters.
const RATE_LIMIT_TAIL_LINES = 12;

export function createBgWatchState() {
  return {
    sessions: new Map(),   // sessionId → { status, waitUntil, attempts, short, lastNeeds, gaveUp, awaiting, awaitingUntil }
    // Memo of successful tz calibrations, shared across sessions (the offset for a
    // given reset wall-clock string cannot change within an episode) — same shape
    // and rationale as the monitor's _tzCache. Deliberately NOT persisted: it is an
    // optimization, and a restarted leader simply re-calibrates on next detection.
    _tzCache: {},
  };
}

// --- persisted state ---
// The watch outlives any single process (leaders rotate as monitors come and go,
// including across the code-drift self-restart), so waits and retry budgets live on
// disk in the same atomic tmp+rename idiom as the pane status files. One file, one
// map keyed by sessionId.

export async function saveBgWatchState(state, file = BG_STATE_FILE) {
  const sessions = {};
  for (const [id, st] of state.sessions) {
    sessions[id] = {
      short: st.short, status: st.status, waitUntil: Math.floor(st.waitUntil),
      attempts: st.attempts, gaveUp: !!st.gaveUp, lastNeeds: st.lastNeeds || '',
      awaiting: !!st.awaiting, awaitingUntil: Math.floor(st.awaitingUntil || 0),
    };
  }
  await mkdir(BG_STATE_DIR, { recursive: true }).catch(() => {});
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ sessions }));
  await rename(tmp, file);
}

export async function loadBgWatchState(file = BG_STATE_FILE) {
  const state = createBgWatchState();
  let raw;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return state; }
  if (raw && raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, st] of Object.entries(raw.sessions)) {
      if (!st || typeof st !== 'object') continue;
      state.sessions.set(id, {
        short: st.short || '',
        status: st.status === 'waiting' ? 'waiting' : 'monitoring',
        waitUntil: Number.isFinite(st.waitUntil) ? st.waitUntil : 0,
        attempts: Number.isFinite(st.attempts) ? st.attempts : 0,
        gaveUp: !!st.gaveUp,
        lastNeeds: st.lastNeeds || '',
        awaiting: !!st.awaiting,
        awaitingUntil: Number.isFinite(st.awaitingUntil) ? st.awaitingUntil : 0,
      });
    }
  }
  return state;
}

// --- leader election ---
// Exactly one watcher in the fleet may drive background sessions (two would
// double-send retries into the same conversation). Any long-lived process may take
// the duty: monitors embed it in their tick loop, `bg watch` goes through the same
// gate. The lock is stolen only when the holder is dead AND its heartbeat is stale
// (a live-but-slow holder must not be deposed by a faster poller), and a steal is
// verified by re-reading — two simultaneous stealers can't both win.

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }   // EPERM: exists, but not ours to signal
}

async function readLock(lockPath) {
  try { return JSON.parse(await readFile(lockPath, 'utf8')); } catch { return null; }
}

export async function acquireBgWatchLock(lockPath = BG_LOCK_FILE, {
  pid = process.pid, nowMs = Date.now(),
} = {}) {
  const entry = JSON.stringify({ pid, at: nowMs });
  // Fast path: exclusive create — no lock exists, we are the leader.
  try {
    const fh = await open(lockPath, 'wx');
    await fh.writeFile(entry);
    await fh.close();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const cur = await readLock(lockPath);
  if (cur && cur.pid === pid) {
    await writeFile(`${lockPath}.${pid}.tmp`, entry).then(() => rename(`${lockPath}.${pid}.tmp`, lockPath));
    return true;   // re-heartbeat our own lock
  }
  const alive = Number.isInteger(cur?.pid) && cur.pid > 0 && isPidAlive(cur.pid);
  const fresh = Number.isFinite(cur?.at) && nowMs - cur.at < BG_LOCK_STALE_MS;
  if (alive && fresh) return false;
  // Steal: atomic replace, then verify we actually hold it (a racing stealer's
  // rename can land after ours — last writer wins, and the loser must stand down).
  const tmp = `${lockPath}.${pid}.tmp`;
  await writeFile(tmp, entry);
  await rename(tmp, lockPath);
  const verify = await readLock(lockPath);
  return verify?.pid === pid;
}

export async function releaseBgWatchLock(lockPath = BG_LOCK_FILE, {
  pid = process.pid,
} = {}) {
  const cur = await readLock(lockPath);
  if (cur?.pid === pid) await unlink(lockPath).catch(() => {});
}

// One leader-gated pass: acquire/heartbeat the lock; only the leader loads state,
// ticks, and saves. Everyone else returns 'not-leader' having done nothing. This is
// what the monitor loop calls on its bg cadence, and what `bg watch` runs in a loop.
export async function bgWatchDuty({
  config, logger, lister = listBgSessions, replier = replyToBgSession,
  stateFile = BG_STATE_FILE, lockPath = BG_LOCK_FILE, now = Date.now, pid = process.pid,
} = {}) {
  const leader = await acquireBgWatchLock(lockPath, { pid, nowMs: now() }).catch(() => false);
  if (!leader) return 'not-leader';
  const state = await loadBgWatchState(stateFile);
  const outcome = await bgWatchTick(state, { config, lister, replier, logger, now });
  await saveBgWatchState(state, stateFile).catch(() => {});
  return outcome;
}


// One poll of the watch loop. Pure-ish: every effect (list, reply, log) is
// injectable, and time comes from `now` — the tests drive scenarios end to end.
// Returns one of: 'idle' (nothing blocked), 'waiting' (a fresh wait was armed),
// 'retried' (a resume was sent), 'user-continued' (a tracked session cleared),
// 'max-retries' (a session exhausted its budget), 'gave-up-hold'.
export async function bgWatchTick(state, {
  config, lister = listBgSessions, replier = replyToBgSession,
  logger = null, now = Date.now,
} = {}) {
  const log = logger || { info: async () => {}, warn: async () => {} };
  const jobs = await lister();
  const seen = new Set();
  let outcome = 'idle';

  for (const job of jobs) {
    if (!job.sessionId) continue;
    seen.add(job.sessionId);
    let st = state.sessions.get(job.sessionId);
    if (!st) {
      st = { status: 'monitoring', waitUntil: 0, attempts: 0, short: job.short, lastMessage: null, gaveUp: false };
      state.sessions.set(job.sessionId, st);
    }
    // The short id can change across a daemon-side worker restart for the same
    // conversation; replies address the CURRENT worker, so track the latest.
    st.short = job.short;

    // In-flight latch: a retry was sent and the agent has not come back yet. Never
    // send again while this holds (see BG_SETTLE_MS). A CHANGED banner is the one
    // escape inside the window: new facts supersede the in-flight retry's episode,
    // and the re-arm below computes a fresh (longer) wait — no send can escape it.
    const newBannerWhileAwaiting = st.awaiting && job.needs && st.lastNeeds && job.needs !== st.lastNeeds;
    if (st.awaiting && job.state === 'blocked' && !newBannerWhileAwaiting && now() < (st.awaitingUntil || 0)) continue;
    if (st.awaiting) {
      if (job.state === 'blocked') {
        await log.info(`Background session ${label(job)}: retry sent ${Math.round(BG_SETTLE_MS / 60000)}min ago and the block never lifted — allowing another attempt.`);
      }
      st.awaiting = false;
      st.awaitingUntil = 0;
    }

    if (job.state !== 'blocked') {
      if (st.status === 'waiting' || st.gaveUp) {
        await log.info(`Background session ${label(job)} left the blocked state (${job.state || 'gone'}). Back to monitoring.`);
        outcome = 'user-continued';
      }
      st.status = 'monitoring';
      st.attempts = 0;
      st.gaveUp = false;
      st.waitUntil = 0;
      st.awaiting = false;
      st.awaitingUntil = 0;
      continue;
    }

    // Blocked, but NOT on a usage limit — needs is empty (a queued retry turn
    // running under the stale flag, or the daemon simply not saying) or names
    // another cause (a permission prompt). Never this pipeline's failure family:
    // arm no wait, send nothing.
    if (!isRateLimited(job.needs || '', config.customPatterns, RATE_LIMIT_TAIL_LINES, config.limitPatterns)) {
      if (st.status === 'waiting' || st.gaveUp) {
        await log.info(`Background session ${label(job)} no longer shows a limit banner (needs ${job.needs ? 'changed' : 'cleared'}). Back to monitoring.`);
        outcome = 'user-continued';
        st.status = 'monitoring';
        st.attempts = 0;
        st.gaveUp = false;
        st.waitUntil = 0;
      }
      continue;
    }

    if (st.status !== 'waiting' || (job.needs && job.needs !== st.lastNeeds)) {
      // Fresh detection — or a CHANGED banner while waiting, which means a new
      // limit episode (a rejected retry re-blocked with a later reset): re-arm the
      // wait from the new banner and reset the retry budget, exactly as the pane
      // monitor treats a re-rendered /rate-limit-options menu (fresh episode).
      const { message, parsed, until } = await usageWaitUntil(job.needs, config, state._tzCache, now());
      const rearm = st.status === 'waiting';
      st.status = 'waiting';
      st.waitUntil = until;
      st.lastMessage = message;
      st.lastNeeds = job.needs;
      st.attempts = 0;
      st.gaveUp = false;
      st.awaiting = false;
      st.awaitingUntil = 0;
      const secs = Math.max(0, Math.round((until - now()) / 1000));
      await log.info(rearm
        ? `Background session ${label(job)} re-blocked with a new reset: "${ellipsis(message)}". Waiting ${secs}s...`
        : `Background session ${label(job)} rate limited: "${ellipsis(message)}". Waiting ${secs}s...`);
      outcome = 'waiting';
      continue;
    }

    if (now() < st.waitUntil) continue;

    if (st.attempts >= config.maxRetries) {
      if (!st.gaveUp) {
        await log.warn(`Background session ${label(job)}: max retries (${config.maxRetries}) reached; still blocked. Holding until it clears.`);
        st.gaveUp = true;
      }
      outcome = 'max-retries';
      continue;
    }

    st.attempts += 1;
    st.awaiting = true;
    st.awaitingUntil = now() + BG_SETTLE_MS;
    await log.info(`Sending retry message to background session ${label(job)} (attempt ${st.attempts}); standing down until the agent comes back.`);
    await replier(job.short, config.retryMessage);
    // Cooldown between attempts — same backoff shape the pane monitor uses after a
    // send (a rejected turn re-blocks on the next poll; don't hammer the provider).
    st.waitUntil = now() + config.pollIntervalSeconds * 1000 * 12;
    outcome = 'retried';
  }

  for (const id of [...state.sessions.keys()]) {
    if (!seen.has(id)) state.sessions.delete(id);
  }
  return outcome;
}

function label(job) {
  return job.name || job.short || job.sessionId.slice(0, 8);
}

function ellipsis(text, max = 80) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Foreground entry: `claude-auto-retry bg watch`. Manual/on-demand watcher — goes
// through the SAME leader lock the monitors' embedded duty uses, so running it
// alongside live monitors never double-drives a session (it simply reports
// not-leader while a monitor holds the duty).
export async function runBgWatch({ intervalSeconds = null } = {}) {
  const config = await loadConfig();
  const logger = createLogger();
  const intervalMs = (intervalSeconds || config.bgWatch.tickSeconds) * 1000;
  await logger.info(`Background-session watch started (poll every ${intervalMs / 1000}s).`);
  let running = true;
  let everLed = false;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });
  while (running) {
    try {
      const outcome = await bgWatchDuty({ config, logger });
      if (outcome !== 'not-leader') everLed = true;
    } catch (err) {
      await logger.warn(`Background watch tick failed: ${err.message}`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  if (everLed) await releaseBgWatchLock().catch(() => {});
  await logger.info('Background-session watch stopped.').catch(() => {});
}
