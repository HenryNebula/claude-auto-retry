import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotSrcFiles, srcFilesChanged, changedSrcNames, canImportFresh, restartSelf } from '../src/code-drift.js';
import { createMonitorState, adoptPriorUsageWait } from '../src/monitor.js';

const MONITOR_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'monitor.js');
const quietLogger = () => ({ info: async () => {}, warn: async () => {}, error: async () => {} });

describe('snapshotSrcFiles', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'car-drift-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('signatures only .js files, name-sorted, and is stable across calls', async () => {
    writeFileSync(join(dir, 'b.js'), 'export const x = 1;');
    writeFileSync(join(dir, 'a.js'), 'export const y = 2;');
    writeFileSync(join(dir, 'notes.txt'), 'not code');
    const snap = await snapshotSrcFiles(dir);
    assert.equal(snap.length, 2);
    assert.ok(snap[0].startsWith('a.js:'));
    assert.ok(snap[1].startsWith('b.js:'));
    assert.deepEqual(await snapshotSrcFiles(dir), snap);
  });

  it('sees an edit as a new signature (mtime or size)', async () => {
    const before = await snapshotSrcFiles(dir);
    writeFileSync(join(dir, 'a.js'), 'export const y = 2; export const z = 3;');
    const after = await snapshotSrcFiles(dir);
    assert.ok(srcFilesChanged(before, after));
    assert.deepEqual(changedSrcNames(before, after), ['a.js']);
  });

  it('sees an mtime-only touch (same size)', async () => {
    const before = await snapshotSrcFiles(dir);
    const t = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'a.js'), t, t);
    assert.ok(srcFilesChanged(before, await snapshotSrcFiles(dir)));
  });

  it('sees an added and a removed file', async () => {
    const before = await snapshotSrcFiles(dir);
    writeFileSync(join(dir, 'c.js'), 'export const w = 4;');
    assert.ok(srcFilesChanged(before, await snapshotSrcFiles(dir)));
    const mid = await snapshotSrcFiles(dir);
    rmSync(join(dir, 'b.js'));
    assert.ok(srcFilesChanged(mid, await snapshotSrcFiles(dir)));
  });

  it('returns null for an unreadable directory', async () => {
    assert.equal(await snapshotSrcFiles(join(dir, 'nope')), null);
  });
});

describe('srcFilesChanged / changedSrcNames', () => {
  it('never reports a change when either side is null', () => {
    const snap = ['a.js:1:2'];
    assert.equal(srcFilesChanged(null, snap), false);
    assert.equal(srcFilesChanged(snap, null), false);
    assert.equal(srcFilesChanged(null, null), false);
    assert.deepEqual(changedSrcNames(null, snap), []);
    assert.deepEqual(changedSrcNames(snap, null), []);
  });

  it('no change on identical snapshots', () => {
    const snap = ['a.js:1:2', 'b.js:3:4'];
    assert.equal(srcFilesChanged(snap, [...snap]), false);
    assert.deepEqual(changedSrcNames(snap, [...snap]), []);
  });
});

describe('canImportFresh', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'car-probe-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('accepts the real monitor.js (whole module graph loads clean)', async () => {
    assert.equal(await canImportFresh(process.execPath, MONITOR_JS), true);
  });

  it('rejects a syntax error', async () => {
    const file = join(dir, 'broken.js');
    writeFileSync(file, 'export const x = {{{;');
    assert.equal(await canImportFresh(process.execPath, file), false);
  });

  it('rejects a module that throws while evaluating', async () => {
    const file = join(dir, 'throws.js');
    writeFileSync(file, 'throw new Error("boom at load");');
    assert.equal(await canImportFresh(process.execPath, file), false);
  });

  it('rejects a bad import specifier', async () => {
    const file = join(dir, 'missingdep.js');
    writeFileSync(file, 'import { x } from "./does-not-exist.js"; export const y = x;');
    assert.equal(await canImportFresh(process.execPath, file), false);
  });
});

describe('restartSelf', () => {
  it('re-execs detached with identical argv, unrefs, and exits 0', () => {
    const calls = { spawn: null, unref: 0, exit: null };
    const fakeChild = { unref: () => { calls.unref++; } };
    const spawnFn = (execPath, args, opts) => {
      calls.spawn = { execPath, args, opts };
      return fakeChild;
    };
    const exitFn = (code) => { calls.exit = code; };
    restartSelf({ execPath: '/usr/bin/node', entry: '/x/monitor.js', args: ['%9', '4242'], spawnFn, exitFn });
    assert.deepEqual(calls.spawn.args, ['/x/monitor.js', '%9', '4242']);
    assert.equal(calls.spawn.opts.detached, true);
    assert.equal(calls.spawn.opts.stdio, 'ignore');
    assert.equal(calls.unref, 1);
    assert.equal(calls.exit, 0);
  });
});

describe('adoptPriorUsageWait', () => {
  const futureSecs = () => Math.floor(Date.now() / 1000) + 3600;
  const mk = (over = {}) => ({ claudePid: 4242, status: 'waiting', waitUntil: futureSecs(), attempts: 2, gaveUp: false, ...over });

  it('adopts a pending wait for the same pane+claude pid', async () => {
    const state = createMonitorState();
    const until = futureSecs();
    const readStatusFn = async () => mk({ waitUntil: until });
    const adopted = await adoptPriorUsageWait(state, '%0', 4242, quietLogger(), { readStatusFn });
    assert.equal(adopted, true);
    assert.equal(state.status, 'waiting');
    assert.equal(state.waitUntil, until * 1000);
    assert.equal(state.attempts, 2);
    assert.equal(state._gaveUp, false);
    assert.equal(state._waitIsFallback, true);            // adopted correctable, never longer
  });

  it('ignores a snapshot from a different claude pid', async () => {
    const state = createMonitorState();
    const adopted = await adoptPriorUsageWait(state, '%0', 9999, quietLogger(), { readStatusFn: async () => mk() });
    assert.equal(adopted, false);
    assert.equal(state.status, 'monitoring');
  });

  it('ignores a non-waiting snapshot', async () => {
    const state = createMonitorState();
    const adopted = await adoptPriorUsageWait(state, '%0', 4242, quietLogger(), { readStatusFn: async () => mk({ status: 'monitoring' }) });
    assert.equal(adopted, false);
    assert.equal(state.status, 'monitoring');
  });

  it('ignores an expired wait (the schedule already fired)', async () => {
    const state = createMonitorState();
    const readStatusFn = async () => mk({ waitUntil: Math.floor(Date.now() / 1000) - 10 });
    assert.equal(await adoptPriorUsageWait(state, '%0', 4242, quietLogger(), { readStatusFn }), false);
    assert.equal(state.status, 'monitoring');
  });

  it('ignores a missing or corrupt snapshot, and defaults attempts sanely', async () => {
    const state = createMonitorState();
    assert.equal(await adoptPriorUsageWait(state, '%0', 4242, quietLogger(), { readStatusFn: async () => null }), false);
    const state2 = createMonitorState();
    const readStatusFn = async () => mk({ attempts: 'bogus' });
    assert.equal(await adoptPriorUsageWait(state2, '%0', 4242, quietLogger(), { readStatusFn }), true);
    assert.equal(state2.attempts, 0);
  });
});
