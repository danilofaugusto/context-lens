import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, forecastNext } from '../lib/forecast.mjs';

test('backtest returns nulls when 0 valid user pairs exist', () => {
  const parsed = {
    steps: [],
    requests: [{ step: 1, context: 10000, output: 50 }],
    userInputs: [{ step: 0, chars: 100 }]
  };
  const b = backtest(parsed);
  assert.equal(b.forecast, null);
  assert.equal(b.actual, null);
  assert.equal(b.samples, 0);
});

test('forecastNext predicts next context from last request output + median user prompt', () => {
  const parsed = {
    steps: [],
    requests: [
      { step: 1, context: 20000, output: 300 }
    ],
    userInputs: [
      { step: 0, chars: 200 } // 50 tokens
    ]
  };
  const f = forecastNext(parsed);
  assert.equal(f.next, 20000 + 300 + 50);
  assert.equal(f.delta, 350);
});

test('backtest ignores pairs spanning across a compaction CHECKPOINT', () => {
  const parsed = {
    steps: [
      { step_index: 0, type: 'USER_INPUT' },
      { step_index: 1, type: 'PLANNER_RESPONSE' },
      { step_index: 2, type: 'USER_INPUT' },
      { step_index: 3, type: 'CHECKPOINT' },
      { step_index: 4, type: 'PLANNER_RESPONSE' }
    ],
    requests: [
      { step: 1, context: 50000, output: 200 },
      { step: 4, context: 50500, output: 150 } // grows, so only the checkpoint can exclude it
    ],
    userInputs: [
      { step: 0, chars: 100 },
      { step: 2, chars: 100 }
    ]
  };
  const b = backtest(parsed);
  assert.equal(b.samples, 0, 'Should not pair across a compaction checkpoint');
});

test('walk-forward backtest measures actual prediction error on sequential turns', () => {
  const parsed = {
    steps: [],
    requests: [
      { step: 1, context: 20000, output: 500 },
      { step: 3, context: 20600, output: 400 },
      { step: 5, context: 21100, output: 300 }
    ],
    userInputs: [
      { step: 0, chars: 200 }, // 50 tokens
      { step: 2, chars: 400 }, // 100 tokens
      { step: 4, chars: 400 }  // 100 tokens
    ]
  };
  const b = backtest(parsed);
  // Last pair: 20600 + 400 + median([50, 100]) = 21075
  assert.deepEqual(b, { forecast: 21075, actual: 21100, delta: 25, errorPct: 0.1, mape: 0.2, samples: 2 });
});

test('backtest returns null forecast/actual when active turn is immediately post-compaction', () => {
  const parsed = {
    steps: [
      { step_index: 0, type: 'USER_INPUT' },
      { step_index: 1, type: 'PLANNER_RESPONSE' },
      { step_index: 2, type: 'USER_INPUT' },
      { step_index: 3, type: 'PLANNER_RESPONSE' },
      { step_index: 4, type: 'CHECKPOINT' },
      { step_index: 5, type: 'USER_INPUT' },
      { step_index: 6, type: 'PLANNER_RESPONSE' }
    ],
    requests: [
      { step: 1, context: 50000, output: 200 },
      { step: 3, context: 52000, output: 300 },
      { step: 6, context: 15000, output: 200 }
    ],
    userInputs: [
      { step: 0, chars: 100 },
      { step: 2, chars: 100 },
      { step: 5, chars: 100 }
    ],
    lastCheckpoint: 4
  };
  const b = backtest(parsed);
  // Pre-compaction pair existed (sample = 1), but latest active turn (step 5) is post-checkpoint
  // and has no valid post-checkpoint forecast pair yet.
  assert.equal(b.forecast, null);
  assert.equal(b.actual, null);
  assert.equal(b.samples, 1);
  assert.ok(Number.isFinite(b.mape));
});
