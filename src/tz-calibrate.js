import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Standard timezone offsets in minutes.
 * Covers all worldwide standard offsets (including half-hour and 45-min offsets).
 */
const STANDARD_OFFSETS_MIN = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -270, -240, -210, -180,
  -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420,
  480, 525, 540, 570, 600, 630, 660, 720, 780, 840
];

export function defaultClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Snap a raw offset in minutes to the nearest standard timezone offset.
 */
export function snapToStandardOffset(rawOffsetMin) {
  if (!Number.isFinite(rawOffsetMin) || Math.abs(rawOffsetMin) > 15 * 60) return null;
  let closest = STANDARD_OFFSETS_MIN[0];
  let minDelta = Math.abs(rawOffsetMin - closest);
  for (const o of STANDARD_OFFSETS_MIN) {
    const d = Math.abs(rawOffsetMin - o);
    if (d < minDelta) {
      minDelta = d;
      closest = o;
    }
  }
  return minDelta <= 30 ? closest : null;
}

/**
 * Convert a minute offset to an IANA-compatible string.
 */
export function offsetToIANA(offsetMin) {
  if (offsetMin === 0) return 'UTC';
  const h = offsetMin / 60;
  if (Number.isInteger(h)) {
    return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
  }
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Extract a provider request timestamp from text if present.
 * Looks for tags like `[2026091300343353f6f8fd178f4011]` (YYYYMMDDHHmmss).
 */
export function extractProviderTimestamp(text) {
  if (!text) return null;
  const match = text.match(/\[?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})[a-f0-9]*\]?/i);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const hh = parseInt(match[4], 10);
  const mm = parseInt(match[5], 10);
  const ss = parseInt(match[6], 10);
  if (m < 0 || m > 11 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  return Date.UTC(y, m, d, hh, mm, ss);
}

/**
 * Calibrate the timezone offset by comparing Claude's message history with the error message.
 *
 * @param {object} parsed - Object returned by parseResetTime
 * @param {string} [claudeConfigDir] - Path to .claude directory
 * @param {number} [nowMs] - Current time in ms
 * @returns {Promise<{ offsetMinutes: number, timezone: string, firstRaisedUtcMs: number } | null>}
 */
export async function calibrateTimezoneFromHistory(
  parsed,
  claudeConfigDir = defaultClaudeConfigDir(),
  nowMs = Date.now()
) {
  if (!parsed || !parsed.needsTzCalibration) return null;

  const resetStr = parsed.isoDateTimeStr;
  const maxAgeMs = 48 * 3600_000; // Search files modified in the last 48 hours
  const matches = [];

  // Helper to record a matching entry
  const recordMatch = (utcMs, text) => {
    if (Number.isFinite(utcMs) && text) {
      matches.push({ utcMs, text });
    }
  };

  // 1. Search jobs/*/timeline.jsonl
  try {
    const jobsDir = join(claudeConfigDir, 'jobs');
    const jobs = await readdir(jobsDir);
    for (const j of jobs) {
      const tlPath = join(jobsDir, j, 'timeline.jsonl');
      try {
        const s = await stat(tlPath);
        if (nowMs - s.mtimeMs > maxAgeMs) continue;
        const content = await readFile(tlPath, 'utf8');
        for (const line of content.split('\n')) {
          if (!line) continue;
          if (resetStr && !line.includes(resetStr)) continue;
          try {
            const obj = JSON.parse(line);
            const t = new Date(obj.at || obj.timestamp).getTime();
            recordMatch(t, obj.detail || obj.text || line);
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // 2. Search projects/*/*.jsonl
  try {
    const projsDir = join(claudeConfigDir, 'projects');
    const projs = await readdir(projsDir);
    for (const p of projs) {
      const pDir = join(projsDir, p);
      let files = [];
      try {
        files = await readdir(pDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fPath = join(pDir, f);
        try {
          const s = await stat(fPath);
          if (nowMs - s.mtimeMs > maxAgeMs) continue;
          const content = await readFile(fPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line) continue;
            if (resetStr && !line.includes(resetStr)) continue;
            try {
              const obj = JSON.parse(line);
              const t = new Date(obj.timestamp || (obj.snapshot && obj.snapshot.timestamp)).getTime();
              recordMatch(t, line);
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  if (matches.length === 0) {
    // If no exact match by resetStr, try searching for recent rate limit error entries
    // that occurred within the last 15 minutes
    try {
      const jobsDir = join(claudeConfigDir, 'jobs');
      const jobs = await readdir(jobsDir);
      for (const j of jobs) {
        const tlPath = join(jobsDir, j, 'timeline.jsonl');
        try {
          const s = await stat(tlPath);
          if (nowMs - s.mtimeMs > 30 * 60_000) continue;
          const content = await readFile(tlPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line || !line.includes('Usage limit reached')) continue;
            try {
              const obj = JSON.parse(line);
              const t = new Date(obj.at || obj.timestamp).getTime();
              recordMatch(t, obj.detail || obj.text || line);
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  if (matches.length === 0) return null;

  // Sort chronologically to find when the message was FIRST raised
  matches.sort((a, b) => a.utcMs - b.utcMs);
  const first = matches[0];
  const firstRaisedUtcMs = first.utcMs;

  // Method 1: Check for embedded provider timestamp in the first raised entry (or parsed raw text)
  const providerTs = extractProviderTimestamp(first.text) || extractProviderTimestamp(parsed.rawText);
  if (providerTs !== null) {
    const rawDiffMin = (providerTs - firstRaisedUtcMs) / 60_000;
    const offsetMinutes = snapToStandardOffset(rawDiffMin);
    if (offsetMinutes !== null) {
      return {
        offsetMinutes,
        timezone: offsetToIANA(offsetMinutes),
        firstRaisedUtcMs,
      };
    }
  }

  // Method 2: Use reset time and limit duration (or default limit horizon)
  if (parsed.isoWallClockMs) {
    const resetWallMs = parsed.isoWallClockMs;
    const limitWindowMs = (parsed.limitHours ? parsed.limitHours : 5) * 3600_000;
    // The reset must be between now (or first raised) and (first raised + limit window)
    // 0 <= (resetWallMs - offsetMs) - firstRaisedUtcMs <= limitWindowMs
    const candidateOffsets = [];
    for (const offset of STANDARD_OFFSETS_MIN) {
      const trueResetMs = resetWallMs - offset * 60_000;
      const waitFromFirstRaised = trueResetMs - firstRaisedUtcMs;
      if (waitFromFirstRaised >= 0 && waitFromFirstRaised <= limitWindowMs + 60_000) {
        candidateOffsets.push(offset);
      }
    }
    if (candidateOffsets.length > 0) {
      // Pick the offset that gives a positive future wait closest to now, or closest to host timezone
      const hostTzOffsetMin = -new Date().getTimezoneOffset();
      let best = candidateOffsets[0];
      let minDiff = Math.abs(best - hostTzOffsetMin);
      for (const o of candidateOffsets) {
        const d = Math.abs(o - hostTzOffsetMin);
        if (d < minDiff) {
          minDiff = d;
          best = o;
        }
      }
      return {
        offsetMinutes: best,
        timezone: offsetToIANA(best),
        firstRaisedUtcMs,
      };
    }
  }

  return null;
}
