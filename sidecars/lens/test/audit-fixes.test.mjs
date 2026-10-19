// Tests added by the false-negative audit. All PASS on current code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBreakdown } from '../lib/breakdown.mjs';
import { backtest, forecastNext } from '../lib/forecast.mjs';
import { parseTranscript } from '../lib/parse.mjs';
import { resolveSafeBrainPath } from '../lib/paths.mjs';
import { createTtlCache } from '../lib/cache.mjs';
import { getEnabledPlugins, scanRules, scanSkills, scanAgents } from '../lib/scan.mjs';

const NO_STATIC = { rules: [], skills: [], agents: [] };
const cat = (res, id) => res.categories.find(c => c.id === id);
const items = (res, id) => cat(res, id).items.map(i => [i.label, i.tokens]);

// FN-1: residuals differ, so median != mean and the k >= 3 threshold shows in mape
function variedBiasFixture() {
  const userInputs = [0, 2, 4, 6, 8].map(step => ({ step, chars: 400 })); // 100 tokens each
  const contexts = [10000, 10300, 10900, 11200, 11700]; // residuals: 100, 400, 100, 300
  const requests = [1, 3, 5, 7, 9].map((step, i) => ({ step, context: contexts[i], output: 100 }));
  return { steps: [], requests, userInputs };
}
test('FN-1 backtest uses median bias only from k >= 3', () => {
  assert.deepEqual(backtest(variedBiasFixture()),
    { forecast: 11500, actual: 11700, delta: 200, errorPct: 1.7, mape: 1.8, samples: 4 });
});
test('FN-1 forecastNext uses median of residuals', () => {
  assert.deepEqual(forecastNext(variedBiasFixture()), { next: 12100, delta: 400 });
});

// FN-2: exactly 2 residuals -> forecastNext bias must stay 0
test('FN-2 forecastNext applies no bias with only 2 residuals', () => {
  const f = forecastNext({
    steps: [],
    requests: [
      { step: 1, context: 20000, output: 500 },
      { step: 3, context: 20600, output: 400 },
      { step: 5, context: 21100, output: 300 }
    ],
    userInputs: [{ step: 0, chars: 200 }, { step: 2, chars: 400 }, { step: 4, chars: 400 }]
  });
  assert.deepEqual(f, { next: 21500, delta: 400 }); // 21100 + 300 + median([50,100,100])
});

// FN-3: TTL eviction must drop only the oldest entry
test('FN-3 createTtlCache evicts only the oldest entry', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const cache = createTtlCache(1000, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

// FN-4: exact category values after a compaction checkpoint
test('FN-4 computeBreakdown after compaction: exact categories and items', () => {
  const res = computeBreakdown({
    userInputs: [{ step: 0, chars: 400 }, { step: 2, chars: 4000 }, { step: 6, chars: 800 }],
    lastCheckpoint: 5, checkpointChars: 2000,
    requests: [
      { step: 1, context: 10000, output: 100, contentChars: 400, argsChars: 0 },
      { step: 3, context: 30000, output: 100, contentChars: 0, argsChars: 400 },
      { step: 7, context: 12000, output: 100, contentChars: 400, argsChars: 0 }
    ],
    toolCalls: [
      { step: 3, name: 'old', summary: 'Old', argsChars: 400, outputChars: 40000 },
      { step: 7, name: 'view_file', summary: 'New', argsChars: 0, outputChars: 1200 }
    ]
  }, NO_STATIC);
  assert.equal(cat(res, 'system').tokens, 9900);   // 10000 - ceil(400 / 4)
  assert.equal(cat(res, 'messages').tokens, 1527); // round(2100 * 3200 / 4400)
  assert.equal(cat(res, 'tools').tokens, 573);
  assert.deepEqual(items(res, 'messages'),
    [['Compaction Summary', 954], ['User Prompts', 382], ['Assistant Responses', 191]]);
  assert.deepEqual(items(res, 'tools'), [['view_file: New', 573]]); // pre-checkpoint call dropped
});

// FN-5: exact split without checkpoint; args count; tools newest first; item weights
test('FN-5 computeBreakdown exact split, args, newest-first tools', () => {
  const res = computeBreakdown({
    userInputs: [{ step: 0, chars: 400 }], lastCheckpoint: -1,
    requests: [
      { step: 1, context: 10000, output: 1, contentChars: 0, argsChars: 0 },
      { step: 3, context: 13000, output: 1, contentChars: 800, argsChars: 400 }
    ],
    toolCalls: [
      { step: 1, name: 'a', summary: 'A', argsChars: 0, outputChars: 400 },
      { step: 3, name: 'b', summary: 'B', argsChars: 0, outputChars: 2000 }
    ]
  }, NO_STATIC);
  assert.equal(cat(res, 'system').tokens, 9900);
  assert.equal(cat(res, 'messages').tokens, 1240); // round(3100 * 1600 / 4000)
  assert.equal(cat(res, 'tools').tokens, 1860);
  assert.deepEqual(items(res, 'messages'), [['User Prompts', 310], ['Assistant Responses', 930]]);
  assert.deepEqual(items(res, 'tools'), [['b: B', 1550], ['a: A', 310]]);
});

// FN-6: no chars at all -> 50/50 split
test('FN-6 computeBreakdown splits dynamic 50/50 when no chars are known', () => {
  const res = computeBreakdown({
    userInputs: [{ step: 0, chars: 0 }], lastCheckpoint: -1,
    requests: [
      { step: 1, context: 10000, output: 1, contentChars: 0, argsChars: 0 },
      { step: 3, context: 12000, output: 1, contentChars: 0, argsChars: 0 }
    ],
    toolCalls: []
  }, NO_STATIC);
  assert.equal(cat(res, 'messages').tokens, 1000);
  assert.equal(cat(res, 'tools').tokens, 1000);
});

// FN-7: exact scaling values and the 4000 boundary
test('FN-7 static scaling exact values (floor 5975) and boundary (floor 4000)', () => {
  const a = computeBreakdown({
    userInputs: [{ step: 0, chars: 100 }], requests: [{ step: 1, context: 6000, output: 50 }], toolCalls: []
  }, { rules: [{ tokens: 2500 }], skills: [{ tokens: 2500 }], agents: [] });
  assert.deepEqual([cat(a, 'system').tokens, cat(a, 'rules').tokens, cat(a, 'skills').tokens], [2500, 1738, 1737]);

  const b = computeBreakdown({
    userInputs: [], requests: [{ step: 1, context: 4000, output: 1 }], toolCalls: []
  }, { rules: [{ tokens: 3000 }], skills: [], agents: [] });
  assert.deepEqual([cat(b, 'system').tokens, cat(b, 'rules').tokens], [2500, 1500]);
});

// FN-8: parse fields that nothing asserted; last model change wins
test('FN-8 parseTranscript request fields and last model wins', () => {
  const p = parseTranscript([
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'The user changed setting `Model Selection` from None to Gemini 3 Pro.' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 10, cache_read_tokens: 5, output_tokens: 7,
      content: 'abcd', tool_calls: [{ name: 't', args: { toolSummary: '"S"' } }] }),
    JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: 'The user changed setting `Model Selection` from Gemini 3 Pro to Claude Opus 5.5 (High).' })
  ].join('\n'));
  assert.equal(p.model, 'Claude Opus 5.5 (High)');
  const argsChars = JSON.stringify({ toolSummary: 'S' }).length;
  assert.deepEqual(p.requests[0],
    { step: 1, input: 10, cache: 5, output: 7, context: 15, contentChars: 4, argsChars });
  assert.equal(p.toolCalls[0].argsChars, argsChars);
});

// FN-9: 128-char id is the upper bound
test('FN-9 resolveSafeBrainPath accepts a 128-char id', () => {
  const base = resolve(tmpdir(), 'brain-base');
  const id = 'a'.repeat(128);
  assert.equal(resolveSafeBrainPath(base, id), join(base, id));
});

// FN-10: scan paths that no test touched
test('FN-10 scan: global rules/agents/skills, workspace rules, hidden dirs, dedupe, tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-audit-'));
  try {
    const configDir = join(root, 'config');
    const ws = join(root, 'ws');
    const mk = (p, c) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); };
    mk(join(root, 'GEMINI.md'), '1234');                                   // configDir/../GEMINI.md
    mk(join(configDir, 'rules', 'style.md'), '12345678');
    mk(join(configDir, 'agents', 'g.md'), '---\nname: g\ndescription: dd\n---');
    mk(join(configDir, 'skills', 'cs', 'SKILL.md'), '---\nname: cs\ndescription: d\n---');
    mk(join(configDir, 'plugins', '.hidden', 'plugin.json'), '{}');
    mk(join(configDir, 'plugins', 'p1', 'plugin.json'), '{ "name": "Plugin One" }');
    mk(join(configDir, 'plugins', 'p1', 'agents', 'pa.md'), '---\nname: pa\ndescription: x\n---');
    mk(join(ws, 'GEMINI.md'), '12');
    mk(join(ws, '.agents', 'rules', 'r.md'), '123456789');

    const plugins = getEnabledPlugins(configDir);
    assert.deepEqual(plugins.map(p => p.dir), ['p1']);

    const rules = scanRules(plugins, [ws, ws], configDir); // same ws twice -> no duplicates
    assert.deepEqual(rules.map(r => [r.label, r.tokens]), [
      ['global: GEMINI.md', 1], ['global: style.md', 2],
      ['workspace: GEMINI.md', 1], ['workspace: r.md', 3]
    ]);

    const skills = scanSkills(plugins, join(root, 'no-builtin'), configDir);
    const skillPath = resolve(join(configDir, 'skills', 'cs', 'SKILL.md'));
    assert.deepEqual(skills.map(s => [s.label, s.tokens]),
      [['cs', Math.ceil((2 + 1 + skillPath.length + 30) / 4)]]);

    const agents = scanAgents(plugins, configDir);
    assert.deepEqual(agents.map(a => [a.label, a.hint, a.tokens]),
      [['g', 'global', 3], ['pa', 'Plugin One', 3]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
