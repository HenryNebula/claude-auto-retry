// Restart a long-lived monitor into new source code, without losing its pane.
//
// A monitor is forked once per claude launch (see launcher.js / reconcile.js) and then
// runs for days — far outliving the code it loaded at spawn. Fixes land (git pull,
// `npm i -g`, an edit in a dev checkout) and every already-running monitor keeps
// executing the OLD modules until its claude exits. Observed live on 2026-09-27: the
// wrapped/date-only banner recovery was committed at 08:46, but the pane's monitor —
// forked the evening before — still ran the old date-only→midnight-UTC parse, parked a
// rate-limited session until 20:01 (6h17m past the real 13:43 reset), and would have
// kept the bug for the session's whole lifetime.
//
// This module closes that gap; monitor.js drives it once per tick:
//   - snapshotSrcFiles: a cheap signature ("name:mtimeMs:size" per src/*.js file)
//   - srcFilesChanged: strict diff; null (unreadable dir) never triggers a restart
//   - canImportFresh: load the NEW entry in a throwaway subprocess BEFORE the old
//     monitor exits. A module that fails to parse or evaluate must leave the running
//     monitor alone — a monitor that boot-loops on broken code is an unwatched pane.
//   - restartSelf: detached re-exec with the same argv, then a clean exit; the successor
//     re-derives its state from the pane, and adopts a still-pending usage wait from the
//     status file (see adoptPriorUsageWait in monitor.js — the screen alone cannot
//     re-derive a wait whose banner has left the visible tail).
//
// Scope: source files only. A config change (~/.claude-auto-retry.json) is also invisible
// to a running monitor, but config is read once at start and carries user-facing knobs a
// silent midnight restart should not flip mid-wait; leave that to an explicit session
// restart until someone asks for it.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Realpath, not the entry's argv spelling: a globally-installed claude-auto-retry is
// often a symlink into a dev checkout (npm link), and the watch must follow it to the
// real files so edits there are seen — not the link's own (never-changing) mtime.
export const SRC_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));

// Signature of every .js file in `dir`, name-sorted. Null when the directory can't be
// read (deleted checkout, perms) — the caller treats null as "no information" and never
// restarts on it, so a transient FS hiccup can't churn monitors.
export async function snapshotSrcFiles(dir = SRC_DIR) {
  let names;
  try { names = await readdir(dir); } catch { return null; }
  const sigs = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.js')) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && s.isFile()) sigs.push(`${name}:${s.mtimeMs}:${s.size}`);
  }
  return sigs.length ? sigs : null;
}

export function srcFilesChanged(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (before.length !== after.length) return true;
  return before.some((sig, i) => sig !== after[i]);
}

// File names (pre-colon) of the differing signatures — for the restart log line.
export function changedSrcNames(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const names = new Set([
    ...before.map(s => s.slice(0, s.indexOf(':'))),
    ...after.map(s => s.slice(0, s.indexOf(':'))),
  ]);
  return [...names].filter(n => {
    const b = before.find(s => s.startsWith(`${n}:`));
    const a = after.find(s => s.startsWith(`${n}:`));
    return b !== a;
  });
}

// Can the NEW code even load? Runs `node -e "import(<entry>)"` in a subprocess and
// resolves true only on a clean exit. The probe evaluates the entry's whole module
// graph (a broken regex literal, a bad import, a throwing top-level initializer all
// fail here) without side effects: with no positional args process.argv[1] is
// undefined, so monitor.js's direct-run guard stays false and the probe does not
// start a live monitor. Timeout bounds a hung module initializer (a top-level await
// on a stuck socket, say) so a tick is never lost waiting on it.
export function canImportFresh(execPath, entryPath, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    let probe;
    try {
      probe = spawn(execPath,
        ['-e', `import(${JSON.stringify(pathToFileURL(entryPath).href)}).then(() => {}, () => process.exit(1))`],
        { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { probe.kill('SIGKILL'); done(false); }, timeoutMs);
    probe.on('error', () => done(false));
    probe.on('exit', (code) => done(code === 0));
  });
}

// Detached re-exec of this monitor with identical argv (pane, claude pid), then exit 0.
// Detached + stdio:'ignore' + unref — the successor must outlive this process's exit the
// same way it outlived its launcher's (the original fork in launcher.js).
export function restartSelf({
  execPath = process.execPath,
  entry = process.argv[1],
  args = process.argv.slice(2),
  spawnFn = spawn,
  exitFn = process.exit.bind(process),
} = {}) {
  const child = spawnFn(execPath, [entry, ...args], { detached: true, stdio: 'ignore' });
  child?.unref?.();
  exitFn(0);
}
