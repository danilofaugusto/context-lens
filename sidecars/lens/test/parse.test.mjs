import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeArg, MODEL_RE, parseTranscript } from '../lib/parse.mjs';

test('decodeArg unquotes nested JSON strings and primitives', () => {
  assert.equal(decodeArg('"\\"Check log\\""'), 'Check log');
  assert.equal(decodeArg('"Check log"'), 'Check log');
  assert.equal(decodeArg('true'), true);
  assert.equal(decodeArg('false'), false);
  assert.equal(decodeArg('123'), 123);
  assert.deepEqual(decodeArg('{"key":"value"}'), { key: 'value' });
  assert.equal(decodeArg('plain string'), 'plain string');
});

test('MODEL_RE extracts model names from user settings change prompt text', () => {
  const geminiText = 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment...';
  const m1 = geminiText.match(MODEL_RE);
  assert.ok(m1);
  assert.equal(m1[1].trim(), 'Gemini 3.8 Flash (High)');

  const claudeText = 'The user changed setting `Model Selection` from Gemini 3.8 Flash to Claude Opus 5.5 (High).';
  const m2 = claudeText.match(MODEL_RE);
  assert.ok(m2);
  assert.equal(m2[1].trim(), 'Claude Opus 5.5 (High)');
});

test('parseTranscript pairs parallel tool calls with sequential GENERIC output steps', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Hello\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      input_tokens: 15000,
      cache_read_tokens: 2000,
      output_tokens: 120,
      content: 'Running parallel calls',
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: '"/path/to/a.txt"', toolSummary: '"View A"' } },
        { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run tests"' } }
      ]
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Content of a.txt which is 50 chars long...................'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Tests passed 100%'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.model, 'Gemini 3.8 Flash (High)');
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].context, 17000);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].name, 'view_file');
  assert.equal(parsed.toolCalls[0].summary, 'View A');
  assert.equal(parsed.toolCalls[0].outputChars, 'Content of a.txt which is 50 chars long...................'.length);
  assert.equal(parsed.toolCalls[1].name, 'run_command');
  assert.equal(parsed.toolCalls[1].summary, 'Run tests');
  assert.equal(parsed.toolCalls[1].outputChars, 'Tests passed 100%'.length);
});

test('parseTranscript counts both content and thinking in contentChars', () => {
  const line = JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    input_tokens: 100,
    output_tokens: 50,
    content: 'Final reply.',
    thinking: 'Detailed chain of thought.'
  });
  const parsed = parseTranscript(line);
  assert.equal(parsed.requests.length, 1);
  assert.equal(
    parsed.requests[0].contentChars,
    'Final reply.'.length + 'Detailed chain of thought.'.length
  );
});

