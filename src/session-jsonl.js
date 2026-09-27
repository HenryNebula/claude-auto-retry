// Complete a date-only reset scrape from Claude's session transcripts.
//
// A wrapped or abbreviated provider banner can reach the monitor as "… will reset at
// 2026-09-27" — the day without the clock (see the wrapped-banner incident). The full
// text DOES exist on disk: custom-provider 429s are persisted to the session JSONL as
// assistant entries flagged `isApiErrorMessage: true`, carrying the whole banner verbatim.
// This module goes and gets it: tail-read the recently-modified transcripts, find the
// most recent API-error entry whose reset datetime starts with the scraped date, and
// return its full-ISO parse. The screen stays the primary source (stock subscription
// banners never reach the JSONL — there is no assistant entry for a rejected turn — and
// the TUI is the only surface menus and overload renders live on); this is a completion
// fallback for the one banner family that is known to persist.
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseResetTime } from './time-parser.js';
import { defaultClaudeConfigDir } from './tz-calibrate.js';

// The live banner is the LAST thing a limited session writes, so the entry sits at the
// tail of its file; reading the final 64KB finds it without loading the 100MB+ transcripts
// a long session accumulates. A banner deeper than that is stale by construction.
const TAIL_BYTES = 64 * 1024;
// The entry is written within seconds of the banner rendering; retries of this fallback
// (the wait-for-flush pattern) stay inside this window for as long as completing is
// still worthwhile.
const MAX_AGE_MS = 15 * 60_000;

// Read the last `bytes` of a file as text. When the read was truncated (start > 0) the
// first line is likely partial and is dropped; a whole-file read keeps line 1 — the
// single-entry files this scans are exactly that shape.
async function readTail(path, bytes) {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

// parsed: a parseResetTime result with isoDateOnly true. Returns a FULL-ISO parsed shape
// (isoWallClockMs set, isoDateOnly unset, still needsTzCalibration — the wall clock is the
// provider's, exactly as if the screen had carried the whole datetime), or null when no
// qualifying entry exists (not flushed yet, or a render that never persists).
export async function completeDateOnlyReset(parsed, {
  claudeConfigDir = defaultClaudeConfigDir(),
  nowMs = Date.now(),
  tailBytes = TAIL_BYTES,
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  if (!parsed || !parsed.isoDateOnly || !parsed.isoDateTimeStr) return null;

  const projects = await readdir(join(claudeConfigDir, 'projects'), { withFileTypes: true })
    .catch(() => []);
  let best = null;   // most recent qualifying entry wins — concurrency can interleave files
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const files = await readdir(join(claudeConfigDir, 'projects', p.name)).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(claudeConfigDir, 'projects', p.name, f);
      const s = await stat(path).catch(() => null);
      if (!s || nowMs - s.mtimeMs > maxAgeMs) continue;
      const tail = await readTail(path, tailBytes).catch(() => null);
      if (!tail) continue;
      for (const line of tail.split('\n')) {
        // Cheap gate first: the scraped date must appear before anything parses JSON.
        if (!line.includes(parsed.isoDateTimeStr)) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        // STRICT error-entry gate. Conversations ABOUT this tool quote banner text all
        // over their transcripts (this repo's own test fixtures do), and a user/assistant
        // message mentioning a reset datetime must never complete a wait. Only entries
        // Claude Code itself flagged as API errors qualify — the observed shape for the
        // provider-429 family, the only family this fallback serves.
        if (obj.isApiErrorMessage !== true) continue;
        const ts = Date.parse(obj.timestamp || (obj.snapshot && obj.snapshot.timestamp) || '');
        if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxAgeMs) continue;
        // Parse the RAW line: the reset clauses match inside the JSON text just as well
        // (nothing in them JSON-escapes into a different shape).
        const cand = parseResetTime(line);
        // Full datetime only (the whole point), on the SAME day the screen named — an
        // entry for a different day is a different limit episode.
        if (!cand || cand.isoWallClockMs === undefined || cand.isoDateOnly) continue;
        if (!cand.isoDateTimeStr.startsWith(parsed.isoDateTimeStr)) continue;
        if (!best || ts > best.ts) best = { ts, cand };
      }
    }
  }
  return best ? best.cand : null;
}
