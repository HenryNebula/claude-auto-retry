import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findControlSocket, controlExchange, normalizeJob, listBgSessions,
  readBgScreen, replyToBgSession,
} from '../src/bg-sessions.js';
import {
  createBgWatchState, bgWatchTick, saveBgWatchState, loadBgWatchState,
  acquireBgWatchLock, releaseBgWatchLock, bgWatchDuty, BG_LOCK_STALE_MS,
} from '../src/bg-watch.js';
import { loadConfig } from '../src/config.js';

// The live banner the daemon reported for a blocked session on 2026-09-27 (Z.AI
// plan, UTC+8 provider clock) — the exact `needs` string op:list delivered.
const NEEDS = 'rate limited — wait and retry · API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-28 01:43:35][2026092800595263a4d2bd450b4471]';
const quietLogger = () => ({ info: async () => {}, warn: async () => {} });

// Minimal in-test daemon: newline-framed JSON, scripted per-op reply frames.
const unixMockDaemon = (path, handlers) => new Promise((resolve) => {
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        const frames = handlers[req.op]?.(req);
        for (const f of Array.isArray(frames) ? frames : frames ? [frames] : []) {
          conn.write(`${JSON.stringify(f)}\n`);
        }
      }
    });
  });
  server.listen(path, () => resolve(server));
});

describe('findControlSocket', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 'car-bgsock-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null when no daemon dir exists', async () => {
    assert.equal(await findControlSocket(root, 4242), null);
  });

  it('picks the freshest control.sock across daemon instances', async () => {
    for (const inst of ['aaa', 'bbb']) {
      mkdirSync(join(root, 'cc-daemon-4242', inst), { recursive: true });
      writeFileSync(join(root, 'cc-daemon-4242', inst, 'control.sock'), '');
    }
    const older = join(root, 'cc-daemon-4242', 'aaa', 'control.sock');
    const newer = join(root, 'cc-daemon-4242', 'bbb', 'control.sock');
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    assert.equal(await findControlSocket(root, 4242), newer);
  });

  it('ignores other users’ daemon dirs', async () => {
    mkdirSync(join(root, 'cc-daemon-9999', 'zzz'), { recursive: true });
    writeFileSync(join(root, 'cc-daemon-9999', 'zzz', 'control.sock'), '');
    assert.equal(await findControlSocket(root, 4242), join(root, 'cc-daemon-4242', 'bbb', 'control.sock'));
  });
});

describe('control protocol client', () => {
  let dir, sockPath, server;
  const KEY = 'test-control-key';
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'car-bgproto-'));
    sockPath = join(dir, 'control.sock');
    server = await unixMockDaemon(sockPath, {
      list: () => [{ ok: true, jobs: [{ short: 'abcd1234', sessionId: 'abcd1234-0000-0000-0000-000000000000', state: 'blocked', tempo: 'blocked', needs: NEEDS, cwd: '/w' }] }],
      subscribe: () => [
        { type: 'tick' },
        { type: 'snapshot', record: { short: 'abcd1234' }, streamTail: ['line one\n', 'line two\n'] },
      ],
      reply: (req) => (req.auth === KEY
        ? { ok: true }
        : { ok: false, code: 'EAUTH', error: 'bad key' }),
    });
  });
  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('listBgSessions returns normalized live jobs', async () => {
    const jobs = await listBgSessions({ socketPath: sockPath });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].short, 'abcd1234');
    assert.equal(jobs[0].state, 'blocked');
    assert.match(jobs[0].needs, /reset at 2026-09-28 01:43:35/);
  });

  it('normalizeJob tolerates junk records', () => {
    assert.equal(normalizeJob(null), null);
    assert.equal(normalizeJob('nope'), null);
    assert.deepEqual(normalizeJob({}), { short: '', sessionId: '', pid: null, cwd: '', name: '', intent: '', tempo: '', state: '', detail: '', needs: '', startedAt: null });
  });

  it('listBgSessions surfaces daemon errors', async () => {
    const errSock = join(dir, 'err.sock');
    const srv = await unixMockDaemon(errSock, { list: () => ({ ok: false, error: 'roster unavailable' }) });
    try {
      await assert.rejects(() => listBgSessions({ socketPath: errSock }), /roster unavailable/);
    } finally { await new Promise(r => srv.close(r)); }
  });

  it('readBgScreen joins the snapshot frame’s tail', async () => {
    const text = await readBgScreen('abcd1234', { socketPath: sockPath });
    assert.equal(text, 'line one\nline two\n');
  });

  it('replyToBgSession authenticates and submits as a turn', async () => {
    const ok = await replyToBgSession('abcd1234', 'Continue where you left off.', {
      socketPath: sockPath, keyReader: async () => KEY,
    });
    assert.equal(ok.ok, true);
  });

  it('replyToBgSession refreshes the key once on EAUTH then succeeds', async () => {
    let calls = 0;
    const rotated = await replyToBgSession('abcd1234', 'x', {
      socketPath: sockPath,
      keyReader: async () => (calls++ === 0 ? 'stale-key' : KEY),
    });
    assert.equal(rotated.ok, true);
    assert.equal(calls, 2);
  });

  it('replyToBgSession fails hard when the refreshed key is still wrong', async () => {
    await assert.rejects(
      () => replyToBgSession('abcd1234', 'x', { socketPath: sockPath, keyReader: async () => 'stale' }),
      /key mismatch/);
  });

  it('controlExchange times out when nothing replies', async () => {
    const silent = await unixMockDaemon(join(dir, 'silent.sock'), {});
    try {
      await assert.rejects(
        () => controlExchange(join(dir, 'silent.sock'), { proto: 1, op: 'list' }, { timeoutMs: 150 }),
        /timed out/);
    } finally { await new Promise(r => silent.close(r)); }
  });
});

describe('bgWatchTick', () => {
  let config;
  before(async () => { config = await loadConfig(); });
  // Pin the calibration so the wait arithmetic is deterministic in tests: the
  // reset 2026-09-28 01:43:35 on a UTC+8 clock, margin from config.
  const RESET_WALL = '2026-09-28 01:43:35';
  const OFFSET_MIN = 480;
  const detectedAt = Date.parse('2026-09-27T16:59:00Z');   // inside the live incident's window

  function mkJobs(states) {
    return states.map(s => normalizeJob({
      short: s.short, sessionId: s.sessionId || `${s.short}-0000-0000-0000-000000000000`,
      state: s.state, tempo: s.tempo || '', needs: s.needs ?? NEEDS, cwd: s.cwd || '/w', name: s.name || '',
    }));
  }

  it('arms a wait from the daemon-carried banner on first sight', async () => {
    const state = createBgWatchState();
    state._tzCache[RESET_WALL] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    const outcome = await bgWatchTick(state, {
      config, lister: async () => mkJobs([{ short: 'abcd1234', state: 'blocked' }]),
      logger: quietLogger(), now: () => detectedAt,
    });
    assert.equal(outcome, 'waiting');
    const st = state.sessions.get('abcd1234-0000-0000-0000-000000000000');
    assert.equal(st.status, 'waiting');
    // Reset instant 2026-09-27T17:43:35Z minus detection time, plus the margin.
    const expectedSecs = (Date.parse('2026-09-27T17:43:35Z') - detectedAt) / 1000 + config.marginSeconds;
    assert.ok(Math.abs(st.waitUntil - (detectedAt + expectedSecs * 1000)) < 1500, `waitUntil=${st.waitUntil}`);
  });

  it('holds the wait, then sends the retry when it expires', async () => {
    const state = createBgWatchState();
    state._tzCache[RESET_WALL] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    const sent = [];
    const jobs = mkJobs([{ short: 'abcd1234', state: 'blocked' }]);
    const tick = (now) => bgWatchTick(state, {
      config, lister: async () => jobs, replier: async (short, text) => sent.push([short, text]),
      logger: quietLogger(), now: () => now,
    });
    await tick(detectedAt);                                     // detection
    assert.equal(await tick(detectedAt + 60_000), 'idle');      // mid-wait: nothing happens
    assert.deepEqual(sent, []);
    const st = state.sessions.get('abcd1234-0000-0000-0000-000000000000');
    const outcome = await tick(st.waitUntil + 1000);            // wake: send
    assert.equal(outcome, 'retried');
    assert.deepEqual(sent, [['abcd1234', config.retryMessage]]);
    assert.equal(st.attempts, 1);
  });

  it('re-arms when a sent turn is rejected and re-blocks, up to maxRetries', async () => {
    const state = createBgWatchState();
    state._tzCache[RESET_WALL] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    const jobs = mkJobs([{ short: 'abcd1234', state: 'blocked' }]);
    let now = detectedAt;
    const tick = () => bgWatchTick(state, {
      config, lister: async () => jobs, replier: async () => {}, logger: quietLogger(), now: () => now,
    });
    await tick();
    const st = state.sessions.get('abcd1234-0000-0000-0000-000000000000');
    let last;
    for (let i = 1; i <= config.maxRetries; i++) {
      now = st.waitUntil + 1000;
      last = await tick();
      assert.equal(last, 'retried');
      assert.equal(st.attempts, i);
    }
    now = st.waitUntil + 1000;
    assert.equal(await tick(), 'max-retries');
    assert.equal(st.gaveUp, true);
  });

  it('resets a session that left the blocked state (resume landed)', async () => {
    const state = createBgWatchState();
    state._tzCache[RESET_WALL] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    let jobs = mkJobs([{ short: 'abcd1234', state: 'blocked' }]);
    const tick = (now) => bgWatchTick(state, {
      config, lister: async () => jobs, replier: async () => {}, logger: quietLogger(), now: () => now,
    });
    await tick(detectedAt);
    jobs = mkJobs([{ short: 'abcd1234', state: 'working', tempo: 'active', needs: '' }]);
    assert.equal(await tick(detectedAt + 5000), 'user-continued');
    const st = state.sessions.get('abcd1234-0000-0000-0000-000000000000');
    assert.equal(st.status, 'monitoring');
    assert.equal(st.attempts, 0);
  });

  it('drops tracking when a session disappears from the roster', async () => {
    const state = createBgWatchState();
    let jobs = mkJobs([{ short: 'abcd1234', state: 'blocked' }]);
    await bgWatchTick(state, { config, lister: async () => jobs, logger: quietLogger(), now: () => detectedAt });
    jobs = [];
    await bgWatchTick(state, { config, lister: async () => jobs, logger: quietLogger(), now: () => detectedAt });
    assert.equal(state.sessions.size, 0);
  });

  it('re-arms as a fresh episode when the banner changes mid-wait', async () => {
    const state = createBgWatchState();
    state._tzCache[RESET_WALL] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    const LATER = 'rate limited — wait and retry · API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-29 07:00:00][x]';
    state._tzCache['2026-09-29 07:00:00'] = { offsetMinutes: OFFSET_MIN, timezone: 'Asia/Shanghai' };
    const sent = [];
    let jobs = mkJobs([{ short: 'abcd1234', state: 'blocked' }]);
    const tick = (now) => bgWatchTick(state, {
      config, lister: async () => jobs, replier: async (s, t) => sent.push([s, t]), logger: quietLogger(), now: () => now,
    });
    await tick(detectedAt);
    const st = state.sessions.get('abcd1234-0000-0000-0000-000000000000');
    await tick(st.waitUntil + 1000);                     // send attempt 1
    assert.equal(st.attempts, 1);
    jobs = mkJobs([{ short: 'abcd1234', state: 'blocked', needs: LATER }]);   // re-blocked, new reset
    const outcome = await tick(st.waitUntil + 2000);
    assert.equal(outcome, 'waiting');
    assert.equal(st.attempts, 0);                        // fresh episode: budget reset
    assert.ok(st.waitUntil > detectedAt + 20 * 3600_000); // armed on the NEW reset
    assert.deepEqual(sent, [['abcd1234', config.retryMessage]]);
  });
});

describe('bg-watch persistence and leader lock', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'car-bgstate-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const stateFile = () => join(dir, 'state.json');
  const lockFile = () => join(dir, 'lock');

  it('round-trips wait state through the persisted store', async () => {
    const state = createBgWatchState();
    state.sessions.set('sid-1', { status: 'waiting', waitUntil: 123456, attempts: 2, gaveUp: true, short: 'aa', lastNeeds: 'banner' });
    await saveBgWatchState(state, stateFile());
    const loaded = await loadBgWatchState(stateFile());
    const st = loaded.sessions.get('sid-1');
    assert.equal(st.status, 'waiting');
    assert.equal(st.waitUntil, 123456);
    assert.equal(st.attempts, 2);
    assert.equal(st.gaveUp, true);
    assert.equal(st.lastNeeds, 'banner');
  });

  it('treats a missing/corrupt store as empty and skips junk entries', async () => {
    assert.equal((await loadBgWatchState(join(dir, 'nope.json'))).sessions.size, 0);
    writeFileSync(stateFile(), '{corrupt');
    assert.equal((await loadBgWatchState(stateFile())).sessions.size, 0);
    writeFileSync(stateFile(), JSON.stringify({ sessions: { junk: 'not-an-object' } }));
    assert.equal((await loadBgWatchState(stateFile())).sessions.size, 0);
  });

  // A pid guaranteed alive (this test runner) and one guaranteed dead (a reaped
  // child) — never fixed numbers, whose liveness varies by system.
  const LIVE = process.pid;
  const deadPid = spawnSync('true').pid;   // reaped on exit: guaranteed dead

  it('elects exactly one leader: second acquire fails while the first is fresh and alive', async () => {
    const now = 1_000_000;
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now }), true);
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 222, nowMs: now + 1000 }), false);
    // The holder re-heartbeats its own lock fine.
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now + 2000 }), true);
  });

  it('steals a lock held by a dead pid and verifies ownership', async () => {
    const now = 1_000_000;
    await acquireBgWatchLock(lockFile(), { pid: deadPid, nowMs: now });   // holder died: stealable at once
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now + 1000 }), true);
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 333, nowMs: now + 2000 }), false);
  });

  it('steals a live-but-stale lock only past the staleness window', async () => {
    const now = 2_000_000;
    rmSync(lockFile(), { force: true });
    await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now });
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 333, nowMs: now + BG_LOCK_STALE_MS - 1 }), false);
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 333, nowMs: now + BG_LOCK_STALE_MS + 1 }), true);
  });

  it('release drops the lock only for its own pid', async () => {
    const now = 1_000_000;
    rmSync(lockFile(), { force: true });
    await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now });
    await releaseBgWatchLock(lockFile(), { pid: 333 });     // stranger: no-op
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 333, nowMs: now + 1 }), false);
    await releaseBgWatchLock(lockFile(), { pid: LIVE });    // holder: releases
    assert.equal(await acquireBgWatchLock(lockFile(), { pid: 333, nowMs: now + 2 }), true);
  });

  it('bgWatchDuty skips entirely when another live watcher holds the lock', async () => {
    const config2 = { ...(await loadConfig()) };
    const now = 5_000_000;
    rmSync(lockFile(), { force: true });
    await acquireBgWatchLock(lockFile(), { pid: LIVE, nowMs: now });
    let listed = 0;
    const outcome = await bgWatchDuty({
      config: config2, logger: quietLogger(),
      lister: async () => { listed++; return []; },
      stateFile: stateFile(), lockPath: lockFile(), pid: 424242,
      now: () => now + 1000,
    });
    assert.equal(outcome, 'not-leader');
    assert.equal(listed, 0);   // not even the roster was read
  });

  it('bgWatchDuty ticks and persists when it is the leader', async () => {
    const config2 = { ...(await loadConfig()) };
    const jobs = [normalizeJob({
      short: 'abcd1234', sessionId: 'abcd1234-0000-0000-0000-000000000000',
      state: 'blocked', needs: NEEDS, cwd: '/w',
    })];
    const now = Date.parse('2026-09-27T16:59:00Z');
    const outcome = await bgWatchDuty({
      config: config2, logger: quietLogger(),
      lister: async () => jobs,
      stateFile: stateFile(), lockPath: join(dir, 'lock2'),
      now: () => now,
    });
    assert.equal(outcome, 'waiting');
    const persisted = await loadBgWatchState(stateFile());
    const st = persisted.sessions.get('abcd1234-0000-0000-0000-000000000000');
    assert.equal(st.status, 'waiting');
    assert.equal(st.lastNeeds, NEEDS);
  });
});
