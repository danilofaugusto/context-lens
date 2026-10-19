import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSafeBrainPath } from '../lib/paths.mjs';
import { createFileCache, createTtlCache } from '../lib/cache.mjs';

test('resolveSafeBrainPath accepts valid ids and rejects traversal', () => {
  const base = resolve(tmpdir(), 'brain-base');
  assert.equal(resolveSafeBrainPath(base, 'abc_123-X'), join(base, 'abc_123-X'));
  assert.equal(resolveSafeBrainPath(base, '..'), null);
  assert.equal(resolveSafeBrainPath(base, 'a/b'), null);
  assert.equal(resolveSafeBrainPath(base, 'a\\b'), null);
  assert.equal(resolveSafeBrainPath(base, ''), null);
  assert.equal(resolveSafeBrainPath(base, 'a'.repeat(129)), null);
  assert.equal(resolveSafeBrainPath(base, 42), null);
});

test('createFileCache hits, misses after file change, evicts LRU', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-cache-'));
  try {
    const f = name => { const p = join(dir, name); writeFileSync(p, 'x'); return p; };
    const a = f('a'), b = f('b'), c = f('c');
    const st = p => statSync(p);
    const cache = createFileCache(2);
    cache.set(a, st(a), 'A');
    assert.equal(cache.get(a), 'A');

    writeFileSync(a, 'xx'); // size changes -> stale
    assert.equal(cache.get(a), null);

    cache.set(a, st(a), 'A2');
    cache.set(b, st(b), 'B');
    cache.get(a);              // a is now most recent
    cache.set(c, st(c), 'C');  // evicts b (least recent)
    assert.equal(cache.get(b), null);
    assert.equal(cache.get(a), 'A2');
    assert.equal(cache.get(c), 'C');

    const old = new Date(Date.now() - 60000);
    utimesSync(c, old, old);   // mtime changes -> stale
    assert.equal(cache.get(c), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTtlCache expires entries and evicts oldest', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const cache = createTtlCache(100, 2);
  cache.set('a', 1);
  cache.set('b', 2, 500);
  t.mock.timers.tick(101);
  assert.equal(cache.get('a'), null); // default TTL passed
  assert.equal(cache.get('b'), 2);    // custom TTL still valid
  cache.set('c', 3);
  cache.set('d', 4);                  // size 2 -> evicts b
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('d'), 4);
  assert.equal(cache.get('c'), 3);
});
