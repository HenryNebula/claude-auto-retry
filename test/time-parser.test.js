import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, calculateWaitMs, parseLimitReset } from '../src/time-parser.js';

describe('parseResetTime', () => {
  it('parses "resets 3pm (Europe/Dublin)"', () => {
    const r = parseResetTime('5-hour limit reached - resets 3pm (Europe/Dublin)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Europe/Dublin');
  });
  it('parses "resets at 2pm (America/New_York)"', () => {
    const r = parseResetTime('Usage limit. Resets at 2pm (America/New_York)');
    assert.equal(r.hour, 14); assert.equal(r.timezone, 'America/New_York');
  });
  it('parses "resets 15:30 (Asia/Kolkata)"', () => {
    const r = parseResetTime('resets 15:30 (Asia/Kolkata)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 30);
  });
  it('parses 12pm as noon', () => {
    const r = parseResetTime('resets 12pm (UTC)');
    assert.equal(r.hour, 12);
  });
  it('parses 12am as midnight', () => {
    const r = parseResetTime('resets 12am (UTC)');
    assert.equal(r.hour, 0);
  });
  it('handles no timezone', () => {
    const r = parseResetTime('resets 3pm');
    assert.equal(r.hour, 15); assert.equal(r.timezone, null);
  });
  it('returns null for unparseable text', () => {
    assert.equal(parseResetTime('some random text'), null);
  });
  // Fable review F6: an out-of-range clock ("resets 30") must not parse a bad hour that
  // later makes calculateWaitMs build an Invalid Date and throw (crashing the monitor).
  it('returns null for an out-of-range hour ("resets 30")', () => {
    assert.equal(parseResetTime('resets 30'), null);
  });
  it('parses a 24h-style "resets 12:30" without an am/pm as ambiguous noon/midnight', () => {
    const r = parseResetTime('resets 12:30');
    assert.equal(r.hour, 12); assert.equal(r.minute, 30); assert.equal(r.ambiguous, true);
  });
  it('parses "try again in 5 minutes" as relative time', () => {
    const r = parseResetTime('try again in 5 minutes');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 5 * 60_000);
  });
  it('parses "try again in 2 hours" as relative time', () => {
    const r = parseResetTime('try again in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
  it('parses "wait 30 mins" as relative time', () => {
    const r = parseResetTime('wait 30 mins');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 30 * 60_000);
  });
  it('parses "resets in: 3 hours" as relative time', () => {
    const r = parseResetTime('usage limit · resets in: 3 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 3 * 3_600_000);
  });
  it('parses "resets in 2 hours" as relative time', () => {
    const r = parseResetTime('resets in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
});

describe('calculateWaitMs', () => {
  it('returns positive wait for future time', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 2) % 24;
    const wait = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 60, 5, now);
    assert.ok(wait > 0);
    assert.ok(wait <= 3 * 3600_000);
  });
  it('adds margin seconds', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 1) % 24;
    const w0 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 0, 5, now);
    const w120 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 120, 5, now);
    assert.ok(w120 - w0 >= 119_000 && w120 - w0 <= 121_000);
  });
  it('returns fallback when parsed is null', () => {
    const wait = calculateWaitMs(null, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000);
  });
  // Fable review F6: an ambiguous hour of 12 → the pm interpretation is (12+12)%24 = 0
  // (midnight), NOT hour 24 (which makes `new Date("…T24:…Z")` Invalid → throw → monitor
  // crash-loop). Must return a finite wait, never throw.
  it('does not throw on an ambiguous 12:30 (12+12 → midnight, not hour 24)', () => {
    const now = new Date('2026-07-07T09:00:00Z');
    const wait = calculateWaitMs({ hour: 12, minute: 30, timezone: 'UTC', ambiguous: true }, 60, 5, now);
    assert.ok(Number.isFinite(wait) && wait > 0);
  });
  it('handles ambiguous hour by picking soonest future', () => {
    const now = new Date('2026-03-18T13:00:00Z');
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now
    );
    assert.ok(wait > 0 && wait <= 3 * 3600_000);
  });
  // Ambiguous, BOTH interpretations past & outside grace: roll to the EARLIEST next
  // occurrence (tomorrow's am), not the pm one. "resets 10" at 23:30 Zurich — 10pm passed
  // 1.5h ago (outside grace), 10am passed 13.5h ago → target 10am tomorrow (~10.5h), not
  // 10pm tomorrow (~22.5h). The grace check uses the most-recent interpretation, but the
  // roll must use the earliest.
  it('ambiguous both-past outside grace rolls to the earliest occurrence (am), not pm', () => {
    const now = new Date('2026-07-07T21:30:00Z'); // 23:30 Zurich
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 10 && hours < 11, `expected ~10.5h (10am tomorrow), got ${hours.toFixed(2)}h`);
  });
  // Ambiguous, most-recent interpretation just passed (within grace): retry promptly.
  it('ambiguous within-grace (most-recent interpretation just passed) retries promptly', () => {
    const now = new Date('2026-07-07T20:30:00Z'); // 22:30 Zurich, 30 min after the 10pm interpretation
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true }, 60, 5, now
    );
    assert.ok(wait / 60_000 < 5, `expected a prompt retry (~margin), got ${(wait / 60_000).toFixed(1)}min`);
  });
  it('handles relative time correctly', () => {
    const wait = calculateWaitMs({ relative: true, waitMs: 300_000 }, 60, 5);
    assert.ok(Math.abs(wait - 360_000) < 2000); // 5 min + 60s margin
  });
  it('falls back on invalid timezone', () => {
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Invalid/Zone' }, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000); // fallback
  });

  // Regression (#6): in a positive-offset tz, 10:02 AM Melbourne (UTC+10)
  // looking for "11:40pm Melbourne" should wait ~13.6h (today), not ~37.6h.
  it('targets today for a future reset in a positive-offset timezone', () => {
    const now = new Date('2026-05-03T00:02:15Z'); // 10:02 AM in Melbourne (UTC+10)
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 13 && hours < 14, `expected ~13.6h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): negative-offset tz, "resets 3am NY" at 1am NY → ~2h.
  it('targets today for a future reset in a negative-offset timezone', () => {
    const now = new Date('2026-05-03T05:00:00Z'); // 1:00 AM in New York (UTC-4 EDT)
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'America/New_York' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 1.9 && hours < 2.1, `expected ~2h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): reset already passed today → target tomorrow (~22.6h),
  // not 48h. Symmetric case for the off-by-a-day bug. (1h20m past → beyond the grace
  // window below, so it still rolls to tomorrow.)
  it('targets tomorrow when reset time already passed today', () => {
    const now = new Date('2026-05-03T15:00:00Z'); // 1:00 AM next day in Melbourne
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 22 && hours < 23, `expected ~22.6h, got ${hours.toFixed(2)}h`);
  });

  // Reset-boundary grace window: detecting a limit banner whose reset time only JUST
  // passed (the monitor can settle on the banner minutes-to-~an-hour after the reset,
  // e.g. a session that kept working past it) must retry promptly — the limit has
  // effectively reset — not park ~24h by rolling to tomorrow. Reproduces the live
  // "resets 10am" stall: detected 10:03 Zurich, previously waited 86273s (~24h).
  it('retries promptly when the reset time only just passed (grace window)', () => {
    const now = new Date('2026-07-07T08:03:06Z'); // 10:03 Zurich, 3 min after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    const mins = wait / 60_000;
    assert.ok(mins < 5, `expected a prompt retry (~margin), got ${mins.toFixed(1)}min`);
  });
  it('applies the grace window within the hour after the reset', () => {
    const now = new Date('2026-07-07T08:55:00Z'); // 10:55 Zurich, 55 min after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    assert.ok(wait / 60_000 < 5, 'within 1h grace → prompt retry');
  });
  it('still rolls to tomorrow once the reset is well over an hour past', () => {
    const now = new Date('2026-07-07T10:00:00Z'); // 12:00 Zurich, 2h after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 21 && hours < 23, `expected ~22h (tomorrow), got ${hours.toFixed(2)}h`);
  });
});

// --- Date-bearing resets. Weekly limits render the reset with a calendar date —
//     "You've hit your weekly limit · resets Aug 21 at 3pm (Australia/Brisbane)" (a real
//     Claude Code record, PR #56's fixture) — and the parser only knew clock-only forms, so
//     the banner fell to the 5h fallback: after 5h the monitor woke into a limit with days
//     left on it and burned its retries. The date is authoritative: no today/tomorrow roll.
describe('date-bearing resets (weekly limit)', () => {
  it('parses "resets Aug 21 at 3pm (Australia/Brisbane)" with the calendar date', () => {
    const r = parseResetTime("You've hit your weekly limit · resets Aug 21 at 3pm (Australia/Brisbane)");
    assert.equal(r.hour, 15); assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Australia/Brisbane');
    assert.equal(r.month, 7); assert.equal(r.day, 21);        // month is 0-based (Aug)
  });
  it('parses the long month name and a comma-separated time', () => {
    const r = parseResetTime('resets August 21, 3:30pm (UTC)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 30);
    assert.equal(r.month, 7); assert.equal(r.day, 21);
  });
  it('clock-only forms still carry no date', () => {
    const r = parseResetTime('resets 3pm (UTC)');
    assert.equal(r.month, undefined); assert.equal(r.day, undefined);
  });
  it('waits until the dated instant — days, not the same-day/tomorrow roll', () => {
    // Brisbane is UTC+10, no DST: Aug 21 15:00 Brisbane == Aug 21 05:00Z.
    const now = new Date('2026-08-18T00:00:00Z');
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Australia/Brisbane', month: 7, day: 21 }, 0, 5, now);
    assert.equal(wait, (3 * 24 + 5) * 3600_000);
  });
  it('a dated reset already in the past means the limit cleared — retry now, never roll forward', () => {
    const now = new Date('2026-08-22T00:00:00Z');                 // a day after Aug 21 15:00 Brisbane
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Australia/Brisbane', month: 7, day: 21 }, 60, 5, now);
    assert.equal(wait, 60_000);
  });
  it('infers the year across a December→January boundary', () => {
    const now = new Date('2026-12-30T00:00:00Z');
    const wait = calculateWaitMs({ hour: 9, minute: 0, timezone: 'UTC', month: 0, day: 2 }, 0, 5, now);
    assert.equal(wait, (3 * 24 + 9) * 3600_000);                  // Jan 2 2027 09:00Z
  });
});

// --- Date-only ISO resets: "… will reset at 2026-09-27" — the day named, the clock
//     lost (a pane wrap between date and time, or an abbreviated render). The year
//     used to feed the generic hour clause (\d{1,2} read "20" out of "2026"), turning
//     the banner into a confident "today at 8pm" ~2h past the real reset. ---
describe('parseResetTime — date-only ISO reset', () => {
  const DATE_ONLY = 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-27';
  it('parses as midnight wall-clock marked isoDateOnly, never as an hour', () => {
    const p = parseResetTime(DATE_ONLY);
    assert.equal(p.isoDateOnly, true);
    assert.equal(p.isoWallClockMs, Date.parse('2026-09-27T00:00:00Z'));
    assert.equal(p.limitHours, 5);
    assert.equal(p.needsTzCalibration, true);
  });
  it('a full ISO datetime is not date-only (the full form is tried first)', () => {
    const p = parseResetTime('Usage limit reached for 5 hour. Your limit will reset at 2026-09-27 06:03:10][tag]');
    assert.equal(p.isoDateOnly, undefined);
    assert.equal(p.isoDateTimeStr, '2026-09-27 06:03:10');
  });
  it('the year is never read as an hour by the generic clause', () => {
    // "2026" fed \d{1,2} → hour 20 → "today at 8pm". Now: no match → the bounded,
    // correctable fallback rather than a confident wrong instant.
    assert.equal(parseResetTime('limit resets 2026-09-27'), null);
  });
});

describe('calculateWaitMs — date-only ISO reset', () => {
  const p = () => parseResetTime('Usage limit reached for 5 hour. Your limit will reset at 2026-09-27');
  const MARGIN = 60;
  it('named midnight already past in the calibrated clock → bounded by the limit window', () => {
    // The incident: detected 19:35Z, calibrated +8 puts the named midnight at 16:00Z —
    // past. The true reset sat 2h28m out but no clock was visible, so the 5h window
    // bounds the wait (and the monitor keeps re-reading the live banner).
    const now = new Date('2026-09-26T19:35:07Z');
    assert.equal(calculateWaitMs(p(), MARGIN, 5, now, 480), (5 * 3600 + MARGIN) * 1000);
  });
  it('named midnight future but past the window bound → the bound wins', () => {
    const now = new Date('2026-09-26T10:00:00Z');   // earliest possible = 16:00Z, 6h out
    assert.equal(calculateWaitMs(p(), MARGIN, 5, now, 480), (5 * 3600 + MARGIN) * 1000);
  });
  it('named midnight future within the window bound → earliest possible instant', () => {
    const now = new Date('2026-09-26T14:00:00Z');   // earliest possible = 16:00Z, 2h out
    assert.equal(calculateWaitMs(p(), MARGIN, 5, now, 480), (2 * 3600 + MARGIN) * 1000);
  });
  it('no calibration → configured fallback, as for any ISO reset', () => {
    const now = new Date('2026-09-26T19:35:07Z');
    assert.equal(calculateWaitMs(p(), MARGIN, 9, now, null), (9 * 3600 + MARGIN) * 1000);
  });
});

describe('parseResetTime — truncated spinner text is not a date-only reset', () => {
  it('rejects a date followed by an ellipsis (internal-retry spinner truncation)', () => {
    assert.equal(parseResetTime('Usage limit reached for 5 hour. Your limit will reset at 2026-09-27 … · Retrying in 4s'), null);
  });
});

// --- Provider reset shapes: seconds-relative, offset-bearing ISO, config captures ---
describe('parseResetTime — provider shapes', () => {
  it('reads a seconds-relative clause ("Please try again in 52s" — OpenAI-compat TPM)', () => {
    const parsed = parseResetTime('Rate limit reached for gpt-5.2 on tokens per min (TPM). Please try again in 52s.');
    assert.ok(parsed && parsed.relative);
    assert.equal(parsed.waitMs, 52_000);
  });

  it('reads a bare seconds unit without a trailing period', () => {
    const parsed = parseResetTime('resets in 7s');
    assert.ok(parsed && parsed.relative);
    assert.equal(parsed.waitMs, 7_000);
  });

  it('an offset-bearing ISO datetime is ABSOLUTE — no calibration needed (+08:00)', () => {
    const parsed = parseResetTime('Your limit will reset at 2026-09-27T18:03:10+08:00');
    assert.ok(parsed);
    assert.equal(parsed.absoluteMs, Date.parse('2026-09-27T18:03:10+08:00'));
    assert.equal(parsed.needsTzCalibration, false);
    assert.equal(parsed.isoWallClockMs, undefined);
  });

  it('accepts the compact offset form (+0800) and Z', () => {
    const compact = parseResetTime('reset at 2026-09-27 18:03:10+0800');
    assert.equal(compact.absoluteMs, Date.parse('2026-09-27T18:03:10+08:00'));
    const utc = parseResetTime('reset at 2026-09-27T10:03:10Z');
    assert.equal(utc.absoluteMs, Date.parse('2026-09-27T10:03:10Z'));
  });

  it('a naive ISO datetime still needs calibration (unchanged Z.AI behavior)', () => {
    const parsed = parseResetTime('Your limit will reset at 2026-09-27 06:03:10');
    assert.equal(parsed.needsTzCalibration, true);
    assert.equal(parsed.absoluteMs, undefined);
  });
});

describe('calculateWaitMs — provider shapes', () => {
  it('a seconds-relative clause waits the seconds plus the margin', () => {
    const wait = calculateWaitMs({ relative: true, waitMs: 52_000 }, 60);
    assert.equal(wait, 112_000);
  });

  it('an absolute ISO reset waits exactly until the instant plus margin', () => {
    const now = new Date();
    const target = now.getTime() + 3 * 3600_000;
    const parsed = { absoluteMs: target };
    const wait = calculateWaitMs(parsed, 60, 5, now);
    assert.equal(wait, 3 * 3600_000 + 60_000);
  });

  it('an absolute reset already in the past waits just the margin', () => {
    const now = new Date();
    const parsed = { absoluteMs: now.getTime() - 600_000 };
    assert.equal(calculateWaitMs(parsed, 60, 5, now), 60_000);
  });
});

describe('parseLimitReset — config-taught provider parses', () => {
  const chineseEntry = {
    name: 'cn-provider',
    limit: '用量已达上限',
    reset: '将于\\s*(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})',
    utcOffsetMinutes: 480,
  };

  it('a Chinese banner parses via the capture, with the entry-declared offset', () => {
    const banner = 'API Error: 请求过于频繁，您本时段的用量已达上限，将于 2026-09-27 18:03:10 重置';
    const { parsed, entry } = parseLimitReset(banner, [chineseEntry]);
    assert.equal(entry.name, 'cn-provider');
    assert.ok(parsed && parsed.needsTzCalibration);
    assert.equal(parsed.isoDateTimeStr, '2026-09-27 18:03:10');
    assert.equal(parsed.offsetMinutes, 480);
  });

  it('a capture of a plain ISO WITH offset is absolute — no offset attach, no calibration', () => {
    const e = { name: 'x', limit: 'quota reached', reset: 'at\\s+(\\S+\\s\\S+)', };
    const banner = 'quota reached, at 2026-09-27T18:03:10+08:00 exactly';
    const { parsed } = parseLimitReset(banner, [e]);
    assert.equal(parsed.absoluteMs, Date.parse('2026-09-27T18:03:10+08:00'));
    assert.equal(parsed.needsTzCalibration, false);
  });

  it('a duration capture reads as a duration, not a clock ("3 hours" ≠ 3am)', () => {
    const e = { name: 'x', limit: 'limit', reset: 'retry after\\s+(.+)$' };
    const { parsed } = parseLimitReset('limit hit, retry after 3 hours', [e]);
    assert.ok(parsed && parsed.relative);
    assert.equal(parsed.waitMs, 3 * 3600_000);
  });

  it('a verbatim capture with its own clause words parses directly ("try again in 7s")', () => {
    const e = { name: 'x', limit: 'limit', reset: 'please\\s(.+?)\\.' };
    const { parsed } = parseLimitReset('limit. please try again in 7s.', [e]);
    assert.ok(parsed && parsed.relative);
    assert.equal(parsed.waitMs, 7_000);
  });

  it('a full generic parse beats the entry capture (no downgrade)', () => {
    const banner = 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-27 06:03:10';
    const e = { name: 'x', limit: 'usage limit', reset: '(\\d{4}-\\d{2}-\\d{2})', utcOffsetMinutes: 0 };
    const { parsed } = parseLimitReset(banner, [e]);
    assert.equal(parsed.isoDateTimeStr, '2026-09-27 06:03:10');
    assert.equal(parsed.offsetMinutes, undefined);   // entry offset must NOT override
  });

  it('a date-only generic parse IS upgraded by the entry capture', () => {
    const banner = 'limit hit; will reset at 2026-09-27';    // date-only (wrapped banner shape)
    const e = { name: 'x', limit: 'limit', reset: 'reset at\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})' };
    const { parsed } = parseLimitReset('limit hit; will reset at 2026-09-27 18:03:10', [e]);
    assert.ok(parsed && !parsed.isoDateOnly);
    assert.equal(parsed.isoDateTimeStr, '2026-09-27 18:03:10');
  });

  it('a no-reset entry (Kimi shape) returns parsed:null plus the entry for fallback capping', () => {
    const { parsed, entry } = parseLimitReset(
      'API Error: The engine is currently overloaded, please try again later',
      [{ name: 'kimi', limit: 'engine is currently overloaded', requireReset: false, limitHours: 0.5 }],
    );
    assert.equal(parsed, null);
    assert.equal(entry.limitHours, 0.5);
  });

  it('entries whose limit does not match contribute nothing', () => {
    const { parsed, entry } = parseLimitReset('unrelated text', [chineseEntry]);
    assert.equal(entry, null);
    assert.equal(parsed, null);
  });
});
