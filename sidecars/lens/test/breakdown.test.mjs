import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleItemsToTotal, computeBreakdown } from '../lib/breakdown.mjs';

test('scaleItemsToTotal distributes tokens exactly and matches targetTotal', () => {
  const items = [
    { label: 'A', tokens: 10 },
    { label: 'B', tokens: 20 },
    { label: 'C', tokens: 30 }
  ];
  const scaled = scaleItemsToTotal(items, 100);
  assert.equal(scaled.length, 3);
  const sum = scaled.reduce((acc, it) => acc + it.tokens, 0);
  assert.equal(sum, 100);
  assert.deepEqual(scaled.map(it => it.tokens), [17, 33, 50]);

  // Remainder distribution check
  const scaledOdd = scaleItemsToTotal(items, 97);
  const sumOdd = scaledOdd.reduce((acc, it) => acc + it.tokens, 0);
  assert.equal(sumOdd, 97);
  assert.deepEqual(scaledOdd.map(it => it.tokens), [16, 32, 49]);
});

test('computeBreakdown returns null total when no telemetry is present', () => {
  const res = computeBreakdown({ requests: [] }, {});
  assert.equal(res.total, null);
  assert.equal(res.categories.length, 0);
  assert.ok(res.warnings.length > 0);
});

test('computeBreakdown invariants: category sum equals total, item sums equal category token count', () => {
  const mockParsed = {
    userInputs: [{ step: 0, chars: 400 }],
    lastCheckpoint: -1,
    checkpointChars: 0,
    requests: [
      { step: 1, input: 12000, cache: 3000, output: 100, context: 15000, contentChars: 500, argsChars: 200 }
    ],
    toolCalls: [
      { step: 1, name: 'view_file', summary: 'View sample', argsChars: 200, outputChars: 800 }
    ]
  };

  const mockScanned = {
    rules: [{ label: 'rule1', tokens: 500 }, { label: 'rule2', tokens: 800 }],
    skills: [{ label: 'skill1', tokens: 200 }, { label: 'skill2', tokens: 400 }],
    agents: [{ label: 'agent1', tokens: 150 }]
  };

  const res = computeBreakdown(mockParsed, mockScanned);
  assert.equal(res.total, 15000);

  // Invariant 1: sum of categories equals total
  const catSum = res.categories.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(catSum, res.total);

  // Invariant 2: sum of items equals category tokens
  for (const cat of res.categories) {
    if (cat.items && cat.items.length > 0) {
      const itemSum = cat.items.reduce((acc, it) => acc + it.tokens, 0);
      assert.equal(itemSum, cat.tokens, `Category ${cat.id} items sum must match cat.tokens`);
    }
  }
});

test('computeBreakdown scales static estimates when exceeding measured floor minus 2500', () => {
  const mockParsed = {
    userInputs: [{ step: 0, chars: 100 }],
    lastCheckpoint: -1,
    requests: [
      { step: 1, input: 6000, cache: 0, output: 50, context: 6000, contentChars: 100, argsChars: 50 }
    ],
    toolCalls: []
  };

  const mockScanned = {
    rules: [{ label: 'rule1', tokens: 2500 }],
    skills: [{ label: 'skill1', tokens: 2500 }],
    agents: []
  };

  const res = computeBreakdown(mockParsed, mockScanned);
  assert.equal(res.total, 6000);
  assert.ok(res.warnings.some(w => w.includes('Static file estimates scaled')));
  const catSum = res.categories.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(catSum, 6000);
  const sysCat = res.categories.find(c => c.id === 'system');
  assert.equal(sysCat.tokens, 2500);
  assert.equal(res.categories.find(c => c.id === 'rules').tokens, 1738);
  assert.equal(res.categories.find(c => c.id === 'skills').tokens, 1737);
});
