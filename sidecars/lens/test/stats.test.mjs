import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { normalizeWorkspaceDirs, emptyStatsResponse, buildStats } from '../lib/stats.mjs';

test('normalizeWorkspaceDirs converts file URIs, resolves real paths, dedupes, and drops missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-ws-test-'));
  try {
    const ws1 = join(dir, 'ws1');
    const ws2 = join(dir, 'ws2');
    mkdirSync(ws1);
    mkdirSync(ws2);

    const uri1 = pathToFileURL(ws1).href;
    const nonExistent = join(dir, 'does-not-exist');

    const result = normalizeWorkspaceDirs([
      uri1,
      ws1, // duplicate of ws1
      ws2,
      nonExistent,
      '',
      null
    ]);

    assert.equal(result.length, 2);
    assert.ok(result.includes(ws1));
    assert.ok(result.includes(ws2));
    assert.ok(!result.includes(nonExistent));

    assert.deepEqual(normalizeWorkspaceDirs(null), []);
    assert.deepEqual(normalizeWorkspaceDirs('invalid'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emptyStatsResponse returns default structure with warnings', () => {
  const cfg = { defaultWindow: 200000, autocompactThreshold: 0.8 };
  const resp = emptyStatsResponse(cfg, 'conv-123', '/brain/conv-123', 'Log not found');

  assert.equal(resp.conversationId, 'conv-123');
  assert.equal(resp.brainPath, '/brain/conv-123');
  assert.equal(resp.window, 200000);
  assert.equal(resp.autocompact, 0.8);
  assert.equal(resp.total, null);
  assert.equal(resp.free, null);
  assert.deepEqual(resp.warnings, ['Log not found']);
});

test('buildStats assembles full telemetry with breakdown, window, forecast, and verification', () => {
  const parsed = {
    model: 'Gemini 4 Argon (Medium)',
    requests: [
      { step: 1, context: 10000, output: 100, input: 8000, cache: 2000, contentChars: 400, argsChars: 0 },
      { step: 3, context: 14000, output: 150, input: 1000, cache: 13000, contentChars: 800, argsChars: 0 }
    ],
    userInputs: [
      { step: 0, chars: 400 },
      { step: 2, chars: 400 }
    ],
    toolCalls: []
  };

  const scanned = {
    rules: [{ label: 'workspace: AGENTS.md', tokens: 100 }],
    skills: [{ label: 'test-skill', tokens: 50 }],
    agents: []
  };

  const config = {
    defaultWindow: 1000000,
    windows: {
      'Gemini 4': 1048576
    },
    autocompactThreshold: null
  };

  const meta = {
    conversationId: 'test-conv-abc',
    brainPath: '~/brain/test-conv-abc'
  };

  const stats = buildStats(parsed, scanned, config, meta);

  assert.equal(stats.conversationId, 'test-conv-abc');
  assert.equal(stats.brainPath, '~/brain/test-conv-abc');
  assert.equal(stats.model, 'Gemini 4 Argon (Medium)');
  assert.equal(stats.window, 1048576);
  assert.equal(stats.total, 14000);
  assert.equal(stats.free, 1048576 - 14000);

  assert.deepEqual(stats.lastRequest, {
    step: 3,
    input: 1000,
    cache: 13000,
    output: 150
  });

  assert.ok(Array.isArray(stats.categories));
  const catTotal = stats.categories.reduce((sum, c) => sum + c.tokens, 0);
  assert.equal(catTotal, stats.total);

  const rulesCat = stats.categories.find(c => c.id === 'rules');
  assert.ok(rulesCat);
  assert.equal(rulesCat.tokens, 100);

  assert.ok(stats.forecast.next > stats.total);
  assert.equal(stats.verification.samples, 1);
});
