import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResetTime } from '../src/time-parser.js';
import { completeDateOnlyReset } from '../src/session-jsonl.js';

// A provider-429 entry as Claude Code persists it: an assistant row flagged
// isApiErrorMessage, carrying the banner verbatim, timestamped in UTC. The provider tag
// encodes provider-local time (UTC+8 here) — what tz calibration reads.
function apiErrorEntry(isoTs, resetStr) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: isoTs,
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text: `API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at ${resetStr}][20260927033502aabbccddeeff]` }] },
  });
}

describe('completeDateOnlyReset', () => {
  let cfgDir, savedConfigDir;
  const NOW = Date.now();
  const projDir = () => join(cfgDir, 'projects', 'p');

  before(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    cfgDir = mkdtempSync(join(tmpdir(), 'car-jsonl-'));
  });
  after(() => {
    rmSync(cfgDir, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  const dateOnly = () => parseResetTime('Usage limit reached for 5 hour. Your limit will reset at 2026-09-27');

  it('completes a date-only scrape from the persisted API-error entry', async () => {
    mkdirSync(projDir(), { recursive: true });
    writeFileSync(join(projDir(), 's.jsonl'), apiErrorEntry(new Date(NOW - 30_000).toISOString(), '2026-09-27 06:03:10') + '\n');
    const done = await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW });
    assert.equal(done.isoDateOnly, undefined);
    assert.equal(done.isoDateTimeStr, '2026-09-27 06:03:10');
    assert.equal(done.limitHours, 5);
    assert.equal(done.needsTzCalibration, true);
  });

  it('ignores a banner merely QUOTED in conversation (no isApiErrorMessage flag)', async () => {
    mkdirSync(projDir(), { recursive: true });
    writeFileSync(join(projDir(), 's.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: new Date(NOW - 30_000).toISOString(),
      message: { content: [{ type: 'text', text: 'the banner said: Usage limit reached for 5 hour. Your limit will reset at 2026-09-27 06:03:10][tag]' }] },
    }) + '\n');
    assert.equal(await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW }), null);
  });

  it('ignores a stale entry (an old limit episode, or a fork that copied it forward)', async () => {
    mkdirSync(projDir(), { recursive: true });
    writeFileSync(join(projDir(), 's.jsonl'), apiErrorEntry(new Date(NOW - 3600_000).toISOString(), '2026-09-27 06:03:10') + '\n');
    assert.equal(await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW }), null);
  });

  it('ignores an entry for a DIFFERENT day than the screen named', async () => {
    mkdirSync(projDir(), { recursive: true });
    writeFileSync(join(projDir(), 's.jsonl'), apiErrorEntry(new Date(NOW - 30_000).toISOString(), '2026-09-28 23:00:00') + '\n');
    assert.equal(await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW }), null);
  });

  it('reads only the tail: a banner buried under later content is not found', async () => {
    mkdirSync(projDir(), { recursive: true });
    const later = JSON.stringify({ type: 'user', timestamp: new Date(NOW - 10_000).toISOString(), message: 'x'.repeat(200) });
    writeFileSync(join(projDir(), 's.jsonl'),
      apiErrorEntry(new Date(NOW - 30_000).toISOString(), '2026-09-27 06:03:10') + '\n'
      + Array(600).fill(later).join('\n') + '\n');   // ~140KB past the banner
    assert.equal(await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW }), null);
  });

  it('across files, the most recent qualifying entry wins', async () => {
    mkdirSync(projDir(), { recursive: true });
    writeFileSync(join(projDir(), 'a.jsonl'), apiErrorEntry(new Date(NOW - 120_000).toISOString(), '2026-09-27 05:00:00') + '\n');
    writeFileSync(join(projDir(), 'b.jsonl'), apiErrorEntry(new Date(NOW - 20_000).toISOString(), '2026-09-27 08:30:00') + '\n');
    const done = await completeDateOnlyReset(dateOnly(), { claudeConfigDir: cfgDir, nowMs: NOW });
    assert.equal(done.isoDateTimeStr, '2026-09-27 08:30:00');
  });
});
