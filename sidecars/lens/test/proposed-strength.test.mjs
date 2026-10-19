// Tests that should PASS on current code and FAIL on each mutant M1..M16.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBreakdown } from '../lib/breakdown.mjs';
import { backtest, forecastNext } from '../lib/forecast.mjs';
import { parseTranscript } from '../lib/parse.mjs';
import { resolveWindow } from '../lib/cache.mjs';
import { getEnabledPlugins, scanRules, scanSkills, scanAgents } from '../lib/scan.mjs';

// M6: covered by breakdown.test.mjs ('scaleItemsToTotal distributes tokens exactly...')
// M1: covered by forecast.test.mjs ('backtest ignores pairs spanning across a compaction CHECKPOINT')

// M2: only the context drop can exclude this pair (no checkpoint)
test('context drop alone excludes the pair', () => {
  const b = backtest({
    steps: [],
    requests: [{ step: 1, context: 50000, output: 200 }, { step: 3, context: 12000, output: 150 }],
    userInputs: [{ step: 0, chars: 100 }, { step: 2, chars: 100 }]
  });
  assert.equal(b.samples, 0);
});

// M8: covered by forecast.test.mjs ('walk-forward backtest measures actual prediction error...')

// M5, M16: 4 pairs, constant residual 200 -> bias kicks in at k=3
function biasFixture() {
  const userInputs = [0, 2, 4, 6, 8].map(step => ({ step, chars: 400 }));
  const requests = [1, 3, 5, 7, 9].map((step, i) => ({ step, context: 10000 + 400 * i, output: 100 }));
  return { steps: [], requests, userInputs };
}
test('backtest applies median bias after 3 residuals', () => {
  const b = backtest(biasFixture());
  assert.equal(b.samples, 4);
  assert.equal(b.forecast, 11600);
  assert.equal(b.delta, 0);
});
test('forecastNext applies median bias', () => {
  assert.deepEqual(forecastNext(biasFixture()), { next: 12000, delta: 400 });
});

// M7: post-compaction pair exists -> card must show it
test('backtest shows post-compaction pair', () => {
  const b = backtest({
    steps: [{ step_index: 4, type: 'CHECKPOINT' }],
    requests: [
      { step: 1, context: 50000, output: 200 },
      { step: 3, context: 52000, output: 300 },
      { step: 6, context: 15000, output: 200 },
      { step: 8, context: 15400, output: 100 }
    ],
    userInputs: [0, 2, 5, 7].map(step => ({ step, chars: 100 })),
    lastCheckpoint: 4
  });
  assert.equal(b.samples, 2);
  assert.equal(b.actual, 15400);
  assert.equal(b.forecast, 15225);
});

// M3, M4: inline config, values differ from default
test('resolveWindow longest match, not default', () => {
  const cfg = { defaultWindow: 999, windows: { 'Claude Opus': 1, 'Claude Opus 5.5': 2, 'Claude Sonnet': 3 } };
  assert.equal(resolveWindow('Claude Opus 5.5 (High)', cfg), 2);
  assert.equal(resolveWindow('Claude Sonnet 4.5', cfg), 3);
  assert.equal(resolveWindow('Unknown Model', cfg), 999);
});

// M10
// Intended: item weights include args; category share uses output only.
test('tool item estimate includes args chars', () => {
  const res = computeBreakdown({
    userInputs: [{ step: 0, chars: 0 }], lastCheckpoint: -1,
    requests: [
      { step: 1, context: 10000, output: 10, contentChars: 0, argsChars: 0 },
      { step: 2, context: 12000, output: 10, contentChars: 0, argsChars: 0 }
    ],
    toolCalls: [
      { step: 1, name: 'a', summary: 'A', argsChars: 400, outputChars: 400 },
      { step: 1, name: 'b', summary: 'B', argsChars: 0, outputChars: 800 }
    ]
  }, { rules: [], skills: [], agents: [] });
  const tools = res.categories.find(c => c.id === 'tools');
  assert.equal(tools.items[0].tokens, tools.items[1].tokens);
});

// M13
test('small floor (<4000) scales statics to 60% of floor', () => {
  const res = computeBreakdown({
    userInputs: [], requests: [{ step: 1, context: 3000, output: 1 }], toolCalls: []
  }, { rules: [{ tokens: 5000 }], skills: [], agents: [] });
  assert.equal(res.categories.find(c => c.id === 'rules').tokens, 1800);
  assert.equal(res.categories.find(c => c.id === 'system').tokens, 1200);
});

// M11
test('parseTranscript records last checkpoint', () => {
  const p = parseTranscript([
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }),
    JSON.stringify({ step_index: 1, type: 'CHECKPOINT', content: 'summary-123' })
  ].join('\n'));
  assert.equal(p.lastCheckpoint, 1);
  assert.equal(p.checkpointChars, 11);
});

// M9, M12, M14, M15
test('scan: plugin.json disabled, config override, skill dedupe, workspace rules, agent tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-strength-'));
  try {
    const configDir = join(root, 'config');
    const builtin = join(root, 'builtin');
    const ws = join(root, 'ws');
    const mk = (p, c) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); };
    mk(join(configDir, 'config.json'), '{ "plugins": { "delta": { "enabled": true } } }');
    mk(join(configDir, 'plugins', 'gamma', 'plugin.json'), '{ "disabled": true }');
    mk(join(configDir, 'plugins', 'delta', 'plugin.json'), '{ "disabled": true }');
    mk(join(configDir, 'plugins', 'delta', 'skills', 'dup', 'SKILL.md'), '---\nname: core-skill\ndescription: Plugin copy\n---');
    mk(join(configDir, 'plugins', 'delta', 'agents', 'alpha-worker.md'), '---\nname: alpha-worker\ndescription: Alpha custom subagent\n---');
    mk(join(builtin, 'core', 'SKILL.md'), '---\nname: core-skill\ndescription: Builtin skill\n---');
    mk(join(ws, 'AGENTS.md'), '12345678');

    const plugins = getEnabledPlugins(configDir);
    assert.deepEqual(plugins.map(p => p.dir), ['delta']);

    const skills = scanSkills(plugins, builtin, configDir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].hint, 'Builtin skill');

    const rules = scanRules(plugins, [ws], configDir);
    assert.deepEqual(rules.map(r => [r.label, r.tokens]), [['workspace: AGENTS.md', 2]]);

    const agents = scanAgents(plugins, configDir);
    assert.equal(agents[0].tokens, 10); // ceil((12 + 21 + 6) / 4)
    assert.equal(agents[0].hint, 'delta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
