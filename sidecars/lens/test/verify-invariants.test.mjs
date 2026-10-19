import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTranscript } from '../lib/parse.mjs';
import { computeBreakdown } from '../lib/breakdown.mjs';
import { backtest, forecastNext } from '../lib/forecast.mjs';
import { resolveWindow } from '../lib/cache.mjs';

test('lib pipeline: parse -> breakdown -> forecast on a synthetic transcript', () => {
  const syntheticTranscript = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Analyze project structure\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (Medium).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      input_tokens: 14000,
      cache_read_tokens: 2000,
      output_tokens: 250,
      content: 'Checking project files.',
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: '"/repo/README.md"', toolSummary: '"Read README"' } }
      ]
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      content: '# Project README\nSome documentation content here.'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Run unit tests and summarize results'
    }),
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      input_tokens: 1800,
      cache_read_tokens: 15000,
      output_tokens: 180,
      content: 'All tests passed.',
      tool_calls: []
    })
  ].join('\n');

  const parsed = parseTranscript(syntheticTranscript);
  assert.equal(parsed.model, 'Gemini 4 Argon (Medium)');
  assert.equal(parsed.requests.length, 2);

  const mockScanned = {
    rules: [{ label: 'alpha: AGENTS.md', hint: '~/.gemini/config/plugins/alpha/rules/AGENTS.md', tokens: 300 }],
    skills: [{ label: 'alpha-skill', hint: 'Alpha skill', tokens: 200 }],
    agents: [{ label: 'alpha-worker', hint: 'alpha', tokens: 80 }]
  };

  const breakdown = computeBreakdown(parsed, mockScanned);
  assert.ok(Number.isInteger(breakdown.total), 'Total must be an integer');

  assert.equal(breakdown.total, 16800, 'Breakdown total must match last request context (1800 input + 15000 cache)');

  const catSum = breakdown.categories.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(catSum, breakdown.total, `Category sum (${catSum}) must equal total (${breakdown.total})`);

  for (const cat of breakdown.categories) {
    if (cat.items && cat.items.length > 0) {
      const itemSum = cat.items.reduce((acc, it) => acc + it.tokens, 0);
      assert.equal(itemSum, cat.tokens, `Category ${cat.id} items sum (${itemSum}) must equal cat.tokens (${cat.tokens})`);
    }
  }

  // Inline config: values differ from default so match vs fallback is distinguishable
  const config = { defaultWindow: 999, windows: { 'Gemini 4': 4, 'Gemini': 1 } };
  assert.equal(resolveWindow(parsed.model, config), 4, 'Longest matching key must win');

  const forecast = forecastNext(parsed);
  // 16800 context + 180 output + median(user tokens [39, 9]) = 24; bias 0 (only 1 residual)
  assert.deepEqual(forecast, { next: 17004, delta: 204 });

  const verification = backtest(parsed);
  assert.equal(verification.samples, 1);
});
