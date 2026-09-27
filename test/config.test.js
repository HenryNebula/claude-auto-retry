import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync as writeFile, unlinkSync as unlink } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('DEFAULT_CONFIG', () => {
  it('has expected defaults', () => {
    assert.equal(DEFAULT_CONFIG.maxRetries, 5);
    assert.equal(DEFAULT_CONFIG.pollIntervalSeconds, 5);
    assert.equal(DEFAULT_CONFIG.marginSeconds, 60);
    assert.equal(DEFAULT_CONFIG.fallbackWaitHours, 5);
    assert.equal(typeof DEFAULT_CONFIG.retryMessage, 'string');
    assert.deepEqual(DEFAULT_CONFIG.customPatterns, []);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig('/nonexistent/path/.claude-auto-retry.json');
    assert.deepEqual(config, DEFAULT_CONFIG);
  });
  it('merges partial config with defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: 10 }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 10);
      assert.equal(config.pollIntervalSeconds, 5);
    } finally { await unlink(f); }
  });
  it('returns defaults for invalid JSON', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, 'not json{{{');
    try {
      const config = await loadConfig(f);
      assert.deepEqual(config, DEFAULT_CONFIG);
    } finally { await unlink(f); }
  });
  it('rejects string values and falls back to defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: "never", pollIntervalSeconds: "fast" }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 5);
      assert.equal(config.pollIntervalSeconds, 5);
    } finally { await unlink(f); }
  });
  it('filters invalid customPatterns entries', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ customPatterns: ["valid", 42, null, "[invalid"] }));
    try {
      const config = await loadConfig(f);
      assert.deepEqual(config.customPatterns, ["valid"]);
    } finally { await unlink(f); }
  });
  it('rejects negative numbers and falls back to defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: -1, marginSeconds: -10 }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 5);
      assert.equal(config.marginSeconds, 60);
    } finally { await unlink(f); }
  });
});

// --- limitPatterns: provider banner shapes taught via config ---
describe('limitPatterns validation', () => {
  it('accepts a full entry and applies the documented defaults', async () => {
    const f = join(tmpdir(), `car-limitpatterns-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({
      limitPatterns: [{ limit: 'engine is currently overloaded', reset: 'resets at (\\d{4}-\d{2}-\d{2})' }],
    }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.limitPatterns.length, 1);
      const e = config.limitPatterns[0];
      assert.equal(e.limit, 'engine is currently overloaded');
      assert.equal(e.requireReset, true);            // default: the pairing discipline
      assert.equal(e.name, 'limit-pattern-1');       // default name
      assert.equal(e.utcOffsetMinutes, undefined);
      assert.equal(e.limitHours, undefined);
    } finally { await unlink(f); }
  });

  it('drops entries whose limit does not compile, but keeps the rest', async () => {
    const f = join(tmpdir(), `car-limitpatterns-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({
      limitPatterns: [{ limit: '([unclosed' }, { limit: 'ok limit' }],
    }));
    try {
      const config = await loadConfig(f);
      assert.deepEqual(config.limitPatterns.map((e) => e.limit), ['ok limit']);
    } finally { await unlink(f); }
  });

  it('a bad reset drops only the reset — the limit vocabulary survives', async () => {
    const f = join(tmpdir(), `car-limitpatterns-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({
      limitPatterns: [{ limit: 'spend wall', reset: '[bad' }],
    }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.limitPatterns.length, 1);
      assert.equal(config.limitPatterns[0].reset, undefined);
    } finally { await unlink(f); }
  });

  it('rejects out-of-range offsets and non-positive limitHours', async () => {
    const f = join(tmpdir(), `car-limitpatterns-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({
      limitPatterns: [
        { limit: 'a', utcOffsetMinutes: 2000, limitHours: -3 },
        { limit: 'b', utcOffsetMinutes: 480, limitHours: 0.5 },
      ],
    }));
    try {
      const config = await loadConfig(f);
      const [a, b] = config.limitPatterns;
      assert.equal(a.utcOffsetMinutes, undefined);
      assert.equal(a.limitHours, undefined);
      assert.equal(b.utcOffsetMinutes, 480);
      assert.equal(b.limitHours, 0.5);
    } finally { await unlink(f); }
  });

  it('a non-array limitPatterns degrades to empty', async () => {
    const f = join(tmpdir(), `car-limitpatterns-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ limitPatterns: 'nope' }));
    try {
      const config = await loadConfig(f);
      assert.deepEqual(config.limitPatterns, []);
    } finally { await unlink(f); }
  });
});
