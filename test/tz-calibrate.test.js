import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseResetTime, calculateWaitMs } from '../src/time-parser.js';
import {
  snapToStandardOffset,
  offsetToIANA,
  extractProviderTimestamp,
  calibrateTimezoneFromHistory,
} from '../src/tz-calibrate.js';

describe('snapToStandardOffset', () => {
  it('snaps close offsets to standard zones', () => {
    assert.equal(snapToStandardOffset(480), 480);
    assert.equal(snapToStandardOffset(479.9), 480);
    assert.equal(snapToStandardOffset(-240.2), -240);
    assert.equal(snapToStandardOffset(330), 330); // Asia/Kolkata +5:30
  });

  it('rejects implausible offsets', () => {
    assert.equal(snapToStandardOffset(1000), null);
    assert.equal(snapToStandardOffset(NaN), null);
  });
});

describe('offsetToIANA', () => {
  it('formats positive and negative whole hour offsets', () => {
    assert.equal(offsetToIANA(0), 'UTC');
    assert.equal(offsetToIANA(480), 'Etc/GMT-8'); // POSIX sign inversion
    assert.equal(offsetToIANA(-300), 'Etc/GMT+5');
  });

  it('formats sub-hour offsets', () => {
    assert.equal(offsetToIANA(330), '+05:30');
    assert.equal(offsetToIANA(-210), '-03:30');
  });
});

describe('extractProviderTimestamp', () => {
  it('extracts YYYYMMDDHHmmss from bracketed request IDs', () => {
    const ts = extractProviderTimestamp('[1308][2026091300343353f6f8fd178f4011]');
    assert.ok(ts);
    const d = new Date(ts);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 8); // 0-indexed September
    assert.equal(d.getUTCDate(), 13);
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 34);
    assert.equal(d.getUTCSeconds(), 33);
  });

  it('returns null when no timestamp pattern matches', () => {
    assert.equal(extractProviderTimestamp('some random text [1308]'), null);
  });
});

describe('parseResetTime - ISO format', () => {
  it('parses custom LLM provider rate limit message', () => {
    const msg = '● API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-13 02:29:27][2026091300343353f6f8fd178f4011]';
    const r = parseResetTime(msg);
    assert.ok(r);
    assert.equal(r.needsTzCalibration, true);
    assert.equal(r.isoDateTimeStr, '2026-09-13 02:29:27');
    assert.equal(r.limitHours, 5);
    assert.equal(r.isoWallClockMs, Date.parse('2026-09-13T02:29:27Z'));
  });
});

describe('calculateWaitMs - ISO format with offset', () => {
  it('calculates exact wait when offsetMinutes is provided', () => {
    const parsed = {
      isoWallClockMs: Date.parse('2026-09-13T02:29:27Z'),
      needsTzCalibration: true,
    };
    // Provider timezone is UTC+8 (+480 min). True UTC reset is 2026-09-12 18:29:27Z.
    const now = new Date('2026-09-12T16:34:34Z');
    const margin = 60;
    const wait = calculateWaitMs(parsed, margin, 5, now, 480);
    // Expected wait: (18:29:27 - 16:34:34) = 1h 54m 53s = 6893s + 60s margin = 6953s = 6953000ms
    const expected = (6893 + 60) * 1000;
    assert.equal(wait, expected);
  });

  it('falls back to fallbackHours when offsetMinutes is null', () => {
    const parsed = {
      isoWallClockMs: Date.parse('2026-09-13T02:29:27Z'),
      needsTzCalibration: true,
    };
    const now = new Date('2026-09-12T16:34:34Z');
    const wait = calculateWaitMs(parsed, 60, 5, now, null);
    assert.equal(wait, (5 * 3600 + 60) * 1000);
  });
});

describe('calibrateTimezoneFromHistory', () => {
  let tmpDir;

  it('calibrates offset from mock timeline.jsonl with request ID timestamp', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claude-test-'));
    const jobsDir = join(tmpDir, 'jobs', 'testjob');
    await mkdir(jobsDir, { recursive: true });

    // Entry raised at UTC 2026-09-12 16:34:34.500Z
    // Provider clock in message: 2026-09-13 00:34:34 (offset +8h = 480 min)
    const timelineEntry = {
      at: '2026-09-12T16:34:34.500Z',
      state: 'blocked',
      detail: 'API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-13 02:29:27][20260913003434123456789012]',
    };
    await writeFile(join(jobsDir, 'timeline.jsonl'), JSON.stringify(timelineEntry) + '\n');

    const parsed = parseResetTime(timelineEntry.detail);
    const cal = await calibrateTimezoneFromHistory(parsed, tmpDir, new Date('2026-09-12T16:35:00Z').getTime());
    assert.ok(cal);
    assert.equal(cal.offsetMinutes, 480);
    assert.equal(cal.firstRaisedUtcMs, new Date('2026-09-12T16:34:34.500Z').getTime());

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calibrates offset from reset time and limit window when request ID is absent', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claude-test-2-'));
    const jobsDir = join(tmpDir, 'jobs', 'testjob2');
    await mkdir(jobsDir, { recursive: true });

    // Entry raised at UTC 2026-09-12 16:33:29Z
    // Reset time is 2026-09-13 02:29:27, 5-hour limit
    const timelineEntry = {
      at: '2026-09-12T16:33:29.000Z',
      state: 'blocked',
      detail: 'API Error: Request rejected (429) · [Usage limit reached for 5 hour. Your limit will reset at 2026-09-13 02:29:27]',
    };
    await writeFile(join(jobsDir, 'timeline.jsonl'), JSON.stringify(timelineEntry) + '\n');

    const parsed = parseResetTime(timelineEntry.detail);
    const cal = await calibrateTimezoneFromHistory(parsed, tmpDir, new Date('2026-09-12T16:35:00Z').getTime());
    assert.ok(cal);
    // The offset must put the reset time between 16:33:29Z and 21:33:29Z
    assert.ok(cal.offsetMinutes >= 300 && cal.offsetMinutes <= 600);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
