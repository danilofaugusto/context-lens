// Code bugs found by the audit. FAIL before the scan.mjs fix, PASS after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, redactHomePath } from '../lib/scan.mjs';

test('BUG-1 description starting with "-" or ">" is not a block scalar', () => {
  assert.equal(parseFrontmatter('---\nname: x\ndescription: -v flag helper\n---').description, '-v flag helper');
  assert.equal(parseFrontmatter('---\nname: x\ndescription: >= 2 files\n---').description, '>= 2 files');
  assert.equal(parseFrontmatter('---\nname: x\ndescription: >-\n  folded\n  text\n---').description, 'folded text');
});

test('BUG-2 block description keeps text after a blank line', () => {
  assert.equal(parseFrontmatter('---\nname: x\ndescription: |\n  para one\n\n  para two\n---').description, 'para one para two');
});

test('BUG-3 redactHomePath is case-sensitive for POSIX homes', () => {
  assert.equal(redactHomePath('/home/Al/x', '/home/al'), '/home/Al/x');
  assert.equal(redactHomePath('/home/al/x', '/home/al'), '~/x');
  assert.equal(redactHomePath('c:/users/AL/x', 'C:/Users/al'), '~/x');
});
