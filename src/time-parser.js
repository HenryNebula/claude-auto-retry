// Optional calendar date ahead of the clock — weekly limits render "resets Aug 21 at 3pm
// (Australia/Brisbane)". Month names are matched by their first three letters so both
// "Aug" and "August" resolve; the day may carry an ordinal suffix or a trailing comma.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The hour carries (?!\d): a 4-digit year must never be read as an hour. "reset at
// 2026-09-27" used to match this clause with hour=20 (the greedy \d{1,2} prefix of
// "2026"), silently turning a wrapped banner into "today at 8pm" — see ISO_DATE_ONLY_REGEX.
const RESET_TIME_REGEX = /resets?\s+(?:on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
// Seconds joined the units for OpenAI-compatible providers whose TPM limit reads
// "Please try again in 7s" — same clause, unit the hours/minutes alternation refused.
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|seconds?|secs?|h|m|s)\b/i;

// ISO wall-clock datetime emitted by custom LLM providers — e.g. the format:
//   "Your limit will reset at 2026-09-13 02:29:27"
// There is no timezone indicator; the datetime is in the provider's local clock.
// We parse it naively (treating it as UTC for arithmetic purposes) and return a
// special `isoWallClockMs` shape so that calculateWaitMs can apply a calibrated
// UTC offset supplied by the caller (see tz-calibrate.js).
// The offset group (optional) covers providers that DO state their zone —
// "reset at 2026-09-27T18:03:10+08:00" (or `Z`, or `+0800`) — which makes the instant
// absolute: no calibration, no fallback, one Date.parse.
const ISO_DATETIME_REGEX = /reset(?:s)?\s+at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?/i;
// The same render with the clock missing: "… will reset at 2026-09-27". Two sources:
// a provider that names only the day, and — the observed incident — a pane too narrow
// for the whole banner, where the TUI wraps the line exactly at the space between the
// date and the time and the capture sees only the first physical row. The lookahead
// keeps this from stealing a line that carries the full datetime (checked first above).
const ISO_DATE_ONLY_REGEX = /reset(?:s)?\s+at\s+(\d{4}-\d{2}-\d{2})(?![T ]\d{2}:\d{2})(?!\s*(?:…|\.\.\.))/i;

export function parseResetTime(text) {
  // Try ISO wall-clock datetime first: "reset at 2026-09-13 02:29:27"
  // This format is produced by custom/proxy LLM providers that forward Anthropic
  // rate-limit metadata verbatim but in a non-standard layout.  It must be checked
  // before the hh:mm regex below, which would otherwise consume just the time part
  // and discard the date.
  const isoMatch = text.match(ISO_DATETIME_REGEX);
  if (isoMatch) {
    // Normalise the separator so Date.parse works on both "T" and " " variants.
    const normalised = isoMatch[1].replace(' ', 'T');
    const durMatch = text.match(/limit reached for\s+(\d+)\s*(?:hour|h|minute|min)/i);
    const limitHours = durMatch ? parseInt(durMatch[1], 10) : null;
    // An explicit offset makes the instant absolute — Date.parse does the conversion.
    // "+0800" is not spec-shaped, so insert the colon before handing it over.
    if (isoMatch[2]) {
      const off = isoMatch[2] === 'Z' ? 'Z' : isoMatch[2].replace(/([+-]\d{2})(\d{2})/, '$1:$2');
      const absoluteMs = Date.parse(`${normalised}${off}`);
      if (Number.isFinite(absoluteMs)) {
        return {
          absoluteMs,
          isoDateTimeStr: `${isoMatch[1]}${isoMatch[2]}`,
          limitHours,
          rawText: text,
          needsTzCalibration: false,
        };
      }
    }
    // Parse as if UTC — we don't know the real timezone yet.  The caller can
    // supply an offsetMinutes value (from tz-calibrate.calibrateTimezoneFromHistory)
    // to convert this to a true UTC epoch.
    const naiveMs = Date.parse(`${normalised}Z`);
    if (Number.isFinite(naiveMs)) {
      return {
        isoWallClockMs: naiveMs,
        isoDateTimeStr: isoMatch[1],
        limitHours,
        rawText: text,
        needsTzCalibration: true,
      };
    }
  }

  // Date-only ISO reset: "reset at 2026-09-27". Midnight of the named day, in the
  // provider's wall clock, marked `isoDateOnly` so calculateWaitMs can treat it as
  // "sometime during that day" rather than a precise instant. MUST be tried before
  // the generic hh:mm clause below: that clause's \d{1,2} reads the "20" out of
  // "2026" and produced "today at 8pm" — a confident, uncorrectable wait ~2h past
  // the real reset on a wrapped banner (the incident this shape pins).
  const dateOnlyMatch = text.match(ISO_DATE_ONLY_REGEX);
  if (dateOnlyMatch) {
    const naiveMs = Date.parse(`${dateOnlyMatch[1]}T00:00:00Z`);
    if (Number.isFinite(naiveMs)) {
      const durMatch = text.match(/limit reached for\s+(\d+)\s*(?:hour|h|minute|min)/i);
      const limitHours = durMatch ? parseInt(durMatch[1], 10) : null;
      return {
        isoWallClockMs: naiveMs,
        isoDateTimeStr: dateOnlyMatch[1],
        isoDateOnly: true,
        limitHours,
        rawText: text,
        needsTzCalibration: true,
      };
    }
  }

  // Try absolute time first: "resets at 3pm (UTC)"
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    // A word before the day that isn't a month ("resets tomorrow 3pm") must not be read as
    // one: the optional date group only binds when the token names a month.
    const monthIdx = absMatch[1] ? MONTHS.indexOf(absMatch[1].toLowerCase()) : -1;
    if (absMatch[1] && monthIdx === -1) return null;
    let hour = parseInt(absMatch[3], 10);
    const minute = absMatch[4] ? parseInt(absMatch[4], 10) : 0;
    const ampm = absMatch[5]?.toLowerCase() || null;
    const timezone = absMatch[6] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Reject an out-of-range clock (e.g. a bare "resets 30"): a bad hour/minute would make
    // calculateWaitMs build an invalid Date and throw, crashing the monitor. null → fallback.
    if (hour > 23 || hour < 0 || minute > 59) return null;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    if (monthIdx !== -1) {
      const day = parseInt(absMatch[2], 10);
      if (day < 1 || day > 31) return null;
      return { hour, minute, timezone, ambiguous, month: monthIdx, day };
    }
    return { hour, minute, timezone, ambiguous };
  }

  // Try relative time: "try again in 5 minutes" / "wait 2 hours" / "try again in 7s"
  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const isMinutes = unit.startsWith('m');
    const isSeconds = unit.startsWith('s');
    const ms = amount * (isSeconds ? 1_000 : isMinutes ? 60_000 : 3_600_000);
    return { relative: true, waitMs: ms };
  }

  return null;
}

// Parse a scraped limit banner the way the USAGE-WAIT path needs it: the generic clauses
// first, then — when config limitPatterns teach a provider's shapes — the first entry
// whose `limit` regex matches the banner gets to contribute:
//   - its `reset` capture (group 1) is fed to the clauses as a time span (verbatim, as
//     a duration, then as an instant), which routes a bare ISO datetime, an
//     offset-bearing ISO, a clock, or a relative span through the parser above without
//     it learning the provider's wording (a Chinese banner captures the language-neutral
//     datetime digits; the words stay the regex's job). The capture only UPGRADES a null
//     or date-only generic parse — a full built-in read wins.
//   - its `utcOffsetMinutes`/`limitHours` attach to the parse when it came from this
//     entry (capture-adopted, absent, or date-only), never over a generic full read.
// Returns { parsed, entry } so the caller can bound the fallback wait by entry.limitHours.
export function parseLimitReset(message, limitPatterns = []) {
  let parsed = message ? parseResetTime(message) : null;
  if (!message || !Array.isArray(limitPatterns) || limitPatterns.length === 0) {
    return { parsed, entry: null };
  }
  let entry = null;
  let limit;
  for (const e of limitPatterns) {
    if (!e || typeof e.limit !== 'string') continue;
    try { limit = new RegExp(e.limit, 'i'); } catch { continue; }
    if (limit.test(message)) { entry = e; break; }
  }
  if (!entry) return { parsed, entry: null };
  let viaCapture = false;
  if (typeof entry.reset === 'string' && entry.reset && (!parsed || parsed.isoDateOnly)) {
    try {
      const m = message.match(new RegExp(entry.reset, 'i'));
      if (m && m[1]) {
        // The capture is a TIME SPAN, not a sentence — feed it to the clauses three ways,
        // loosest-first: verbatim (captures that kept their own words, "try again in 7s"),
        // as a duration ("resets in 3 hours" — a bare "3 hours" capture must NOT be read
        // by the clock clause as 3am, so the duration reading comes first), then as an
        // instant ("resets at <datetime|clock>"). ISO digits are language-neutral, which
        // is what makes a non-English banner capturable at all.
        const cap = m[1].trim();
        const p2 = parseResetTime(cap)
          ?? parseResetTime(`resets in ${cap}`)
          ?? parseResetTime(`resets at ${cap}`);
        if (p2) { parsed = p2; viaCapture = true; }
      }
    } catch { /* invalid regex: config validation drops these, but never crash a tick */ }
  }
  if (viaCapture || !parsed || parsed.isoDateOnly) {
    if (Number.isFinite(entry.utcOffsetMinutes) && parsed
        && parsed.needsTzCalibration && parsed.offsetMinutes === undefined) {
      parsed.offsetMinutes = entry.utcOffsetMinutes;
    }
    if (Number.isFinite(entry.limitHours) && entry.limitHours > 0 && parsed
        && parsed.limitHours == null) {
      parsed.limitHours = entry.limitHours;
    }
  }
  return { parsed, entry };
}

// Reset-boundary grace window. A live limit banner whose parsed reset time is already in
// the PAST almost always means the reset just happened: the monitor can settle on the
// banner minutes-to-an-hour after the reset (a session that kept working past it — see the
// chrome-aware anti-spam guard), and Claude's session limits reset on short cadences, so a
// past reset time is recent, not "tomorrow". Rolling a just-passed reset a full day forward
// parks the session ~24h even though the limit has effectively cleared (observed live:
// "resets 10am" detected at 10:03 → 86273s wait). rollPastReset retries promptly instead
// (diff→0, so the wait is just the margin); only a reset MORE than the grace window in the
// past plausibly means the next occurrence is tomorrow — and "tomorrow" must be computed
// date-anchored (getTargetTimestamp with dayOffset 1), NOT as a flat +24h of milliseconds:
// across a DST fall-back transition tomorrow's wall-clock time is 25h away, so +24h woke
// the monitor an hour EARLY with the banner still live (burning maxRetries into a limited
// session, then giving up before the real reset); spring-forward over-waited an hour.
const RESET_GRACE_MS = 60 * 60 * 1000; // 1 hour

export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date(), offsetMinutes = null) {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  // Handle relative times: "try again in 5 minutes" / "in 7s"
  if (parsed.relative) {
    return parsed.waitMs + marginSeconds * 1000;
  }

  // Handle an offset-bearing ISO datetime ("reset at 2026-09-27T18:03:10+08:00"): the
  // instant is absolute — no calibration to wait for, no fallback. Checked ahead of the
  // naive-ISO branch, which would otherwise discard the offset and park the wait on a
  // calibration that can never succeed (no provider tag to derive one from).
  if (parsed.absoluteMs !== undefined) {
    const diff = parsed.absoluteMs - now.getTime();
    return Math.max(0, diff) + marginSeconds * 1000;
  }

  // Handle ISO wall-clock datetime from custom LLM providers.
  if (parsed.isoWallClockMs !== undefined) {
    if (offsetMinutes === null && parsed.offsetMinutes !== undefined) {
      offsetMinutes = parsed.offsetMinutes;
    }
    if (offsetMinutes === null) {
      // No calibration available — fall back to the configured default.
      return (fallbackHours * 3600 + marginSeconds) * 1000;
    }
    const trueResetMs = parsed.isoWallClockMs - offsetMinutes * 60_000;
    let diff = trueResetMs - now.getTime();
    if (parsed.isoDateOnly) {
      // A date-only reset names the DAY the window clears, not the moment. Midnight in
      // the provider's clock is the EARLIEST possible instant; the banner's own limit
      // duration ("reached for 5 hour") bounds it from above — a rolling window that
      // just tripped clears within that many hours of now. Never wait past that bound:
      // waking inside a still-live day is a cheap, correctable re-read, while the old
      // behavior (the year mis-read as an hour) parked the session past the real reset
      // with the correction latch closed. limitHours is null when the banner names no
      // duration (e.g. a weekly limit) — then the configured default bounds it.
      const capMs = (parsed.limitHours ?? fallbackHours) * 3600_000;
      diff = diff > 0 ? Math.min(diff, capMs) : capMs;
    }
    return Math.max(0, diff) + marginSeconds * 1000;
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validate timezone early to avoid cryptic errors later
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    // Invalid timezone (possibly garbled by TUI capture) — use fallback
    return (fallbackHours * 3600 + marginSeconds) * 1000;
  }

  // DST-safe approach: binary search for the correct UTC timestamp that corresponds to
  // the given hour:minute in the target timezone, on today's date there (dayOffset 0) or
  // a following day (dayOffset 1 = the roll-to-tomorrow path — anchored to the actual
  // calendar day so a 23h/25h DST day converges to the right instant).
  // Today's calendar date in the target timezone.
  function todayInTz() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour12: false,
    }).formatToParts(now);
    return {
      y: parseInt(parts.find(p => p.type === 'year').value),
      mo: parseInt(parts.find(p => p.type === 'month').value) - 1,
      d: parseInt(parts.find(p => p.type === 'day').value),
    };
  }
  // `date` ({y, mo, d}) anchors the target to an explicit calendar day (a dated weekly
  // reset); otherwise today in tz, plus dayOffset (the roll-to-tomorrow path).
  function getTargetTimestamp(h, m, dayOffset = 0, date = null) {
    let { y, mo, d } = date || todayInTz();
    if (dayOffset) {
      // Normalize month/year rollover through Date.UTC (calendar-day arithmetic only).
      const norm = new Date(Date.UTC(y, mo, d + dayOffset));
      y = norm.getUTCFullYear(); mo = norm.getUTCMonth(); d = norm.getUTCDate();
    }

    // Construct target date string and parse in HOST-local time as the initial guess
    // (a UTC anchor put the guess up to a full offset away; host-local is usually close).
    const targetStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const guess = new Date(targetStr);

    // Iterative correction: render the guess in the target TZ and move by the FULL
    // wall-clock delta — date included — between desired (today@h:m in tz) and rendered.
    // Anchoring to the date avoids any ±12h minimum-magnitude heuristic, which picked
    // the wrong day whenever the guess landed >12h away in wall-clock terms (banner tz
    // beyond UTC±12 like Pacific/Auckland in summer, or a host/banner offset split >12h)
    // — the off-by-a-day bug. Up to 3 passes for DST convergence.
    // hourCycle h23 (not hour12:false): ICU's h24 quirk can render midnight as "24:xx"
    // paired with the previous day's date, which would skew the date-anchored delta.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    // The candidate's wall-clock rendering in tz, as a comparable UTC-ms scalar.
    const rendered = (ts) => {
      const fp = fmt.formatToParts(new Date(ts));
      const get = t => parseInt(fp.find(p => p.type === t).value);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    };
    const targetWall = Date.UTC(y, mo, d, h, m);

    let candidate = guess.getTime();
    let prev = candidate;
    for (let i = 0; i < 3; i++) {
      const diffMin = (targetWall - rendered(candidate)) / 60_000;
      if (diffMin === 0) break;
      prev = candidate;
      candidate += diffMin * 60_000;
    }

    // DST transition-day resolution — deterministic and host-independent (the loop's
    // outcome otherwise depends on which side the HOST-local initial guess approached
    // from). Both resolve to the LATE side: waking an hour late is safe, waking early
    // finds the banner still live and burns maxRetries.
    if (rendered(candidate) !== targetWall) {
      // Nonexistent wall time (spring-forward gap): the loop oscillates between the
      // instants just before and just after the jump — take the later one (the first
      // real instant at/after the intended time).
      candidate = Math.max(candidate, prev);
    } else if (rendered(candidate + 3600_000) === targetWall) {
      // Repeated wall time (fall-back): converged on the earlier occurrence — move to
      // the later one.
      candidate += 3600_000;
    }

    return candidate;
  }

  // A calendar-dated reset (weekly limit) is authoritative: anchor to that day, never to
  // "today or tomorrow". The year is inferred — the banner's date is the nearest one at or
  // after yesterday in tz, so a "Jan 2" seen on Dec 30 is next year's. Past means the limit
  // already cleared: retry now (margin only), never roll a whole year forward.
  if (parsed.month !== undefined && parsed.day !== undefined) {
    const today = todayInTz();
    const sameYear = Date.UTC(today.y, parsed.month, parsed.day);
    const yesterday = Date.UTC(today.y, today.mo, today.d - 1);
    const y = sameYear >= yesterday ? today.y : today.y + 1;
    const date = { y, mo: parsed.month, d: parsed.day };
    const at = (h) => getTargetTimestamp(h, parsed.minute, 0, date) - now.getTime();
    let target = at(parsed.hour);
    if (parsed.ambiguous) {
      const alt = at((parsed.hour + 12) % 24);
      const future = [target, alt].filter((x) => x > 0);
      target = future.length ? Math.min(...future) : Math.max(target, alt);
    }
    return Math.max(0, target) + marginSeconds * 1000;
  }

  if (parsed.ambiguous) {
    const t1 = getTargetTimestamp(parsed.hour, parsed.minute);
    const t2 = getTargetTimestamp((parsed.hour + 12) % 24, parsed.minute);  // %24: 12→0 (midnight), never hour 24 (→ Invalid Date)
    const d1 = t1 - now.getTime();
    const d2 = t2 - now.getTime();

    let target;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else {
      // Both interpretations are past. Grace-check the MOST RECENT one (is it just-passed?);
      // but if we roll to tomorrow, roll to the EARLIEST occurrence, not the later pm one —
      // otherwise we wait ~12h longer than necessary. Recompute tomorrow's instant
      // date-anchored (dayOffset 1) rather than adding flat 24h, which is ±1h across DST.
      const recent = Math.max(d1, d2);
      const earlyHour = d1 <= d2 ? parsed.hour : (parsed.hour + 12) % 24;
      target = recent > -RESET_GRACE_MS ? 0
        : getTargetTimestamp(earlyHour, parsed.minute, 1) - now.getTime();
    }

    return Math.max(0, target) + marginSeconds * 1000;
  }

  // Roll a stale (past-grace) reset to TOMORROW's occurrence, date-anchored (see the
  // RESET_GRACE_MS comment for both the grace rationale and why not a flat +24h).
  const today = getTargetTimestamp(parsed.hour, parsed.minute) - now.getTime();
  const diff = today >= 0 ? today
    : today > -RESET_GRACE_MS ? 0
    : getTargetTimestamp(parsed.hour, parsed.minute, 1) - now.getTime();

  return diff + marginSeconds * 1000;
}
