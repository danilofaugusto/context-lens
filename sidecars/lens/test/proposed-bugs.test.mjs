// Regression tests for fixed bugs B1-B8. They must PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBreakdown } from '../lib/breakdown.mjs';
import { parseJsonc, redactHomePath, parseFrontmatter } from '../lib/scan.mjs';
import { decodeArg } from '../lib/parse.mjs';

const catSum = r => r.categories.reduce((a, c) => a + c.tokens, 0);

test('B1 category sum equals total when context shrinks below first-turn floor', () => {
  const res = computeBreakdown({
    userInputs: [{ step: 0, chars: 100 }, { step: 4, chars: 100 }],
    lastCheckpoint: 3, checkpointChars: 2000,
    requests: [
      { step: 1, context: 50000, output: 100, contentChars: 0, argsChars: 0 },
      { step: 5, context: 15000, output: 100, contentChars: 0, argsChars: 0 }
    ],
    toolCalls: []
  }, { rules: [], skills: [], agents: [] });
  assert.equal(catSum(res), res.total);
});

test('B1b category sum equals total for context under 1000', () => {
  const res = computeBreakdown({ userInputs: [], requests: [{ step: 1, context: 800, output: 1 }], toolCalls: [] }, {});
  assert.equal(catSum(res), 800);
});

test('B2 parseJsonc keeps Windows path ending in backslash', () => {
  const BS = '\\';
  const cfg = '{ "brainDir": "C:' + BS + BS + 'brain' + BS + BS + '", // note\n "plugins": {} }';
  assert.equal(parseJsonc(cfg).brainDir, 'C:\\brain\\');
});

test('B3 parseJsonc does not touch ",}" inside strings', () => {
  assert.equal(parseJsonc('{ "pattern": "a,}" }').pattern, 'a,}');
  assert.equal(parseJsonc('{ "url": "http://x" }').url, 'http://x');
});

test('B3b parseJsonc still strips comment between trailing comma and brace', () => {
  assert.deepEqual(parseJsonc('{ "a": 1, // c\n }'), { a: 1 });
});

test('B4 redactHomePath respects path boundary', () => {
  assert.equal(redactHomePath('C:/Users/alice/x.md', 'C:/Users/al'), 'C:/Users/alice/x.md');
  assert.equal(redactHomePath('C:/Users/al/x.md', 'C:/Users/al'), '~/x.md');
});

test('B5 parseFrontmatter handles UTF-8 BOM', () => {
  assert.equal(parseFrontmatter('\uFEFF---\nname: bom-skill\ndescription: d\n---').name, 'bom-skill');
});

test('B6 parseFrontmatter empty name does not swallow next line', () => {
  assert.equal(parseFrontmatter('---\nname:\ndescription: real desc\n---').name, '');
});

test('B7 parseFrontmatter plain multi-line description', () => {
  assert.equal(
    parseFrontmatter('---\nname: x\ndescription:\n  line one\n  line two\n---').description,
    'line one line two'
  );
});

test('B8 decodeArg keeps JSON-encoded numeric string as string', () => {
  assert.equal(decodeArg('"123"'), '123');
  assert.equal(decodeArg('"\\"Check log\\""'), 'Check log');
});
