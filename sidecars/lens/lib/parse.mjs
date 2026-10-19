function isJsonLike(t) {
  if (!t) return false;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === '"' && last === '"') || (first === '{' && last === '}') || (first === '[' && last === ']')) {
    return true;
  }
  if (t === 'true' || t === 'false') return true;
  return /^-?\d+(\.\d+)?$/.test(t);
}

// Decode values the transcript stores JSON-encoded, e.g. "\"Check log\"" -> "Check log".
export function decodeArg(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.length > 65536) return v;
  if (isJsonLike(t)) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') {
        const t2 = parsed.trim();
        if (/^["{[]/.test(t2) && isJsonLike(t2)) {
          try { return JSON.parse(t2); } catch { return parsed; }
        }
      }
      return parsed;
    } catch {
      return v;
    }
  }
  return v;
}

export const MODEL_RE = /changed setting `Model Selection` from .+? to (.+?)\.(?=\s*(?:[A-Z]|<|\n|$))/;

export function parseTranscript(text) {
  const rawSteps = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rawSteps.push(JSON.parse(line)); } catch { /* ignore partial trailing line */ }
  }
  const steps = [], requests = [], userInputs = [], toolCalls = [];
  let lastCheckpoint = -1, checkpointChars = 0, model = null, pending = [];

  for (const s of rawSteps) {
    const content = typeof s.content === 'string' ? s.content : '';
    steps.push({ step_index: s.step_index, type: s.type });

    if (s.type === 'USER_INPUT') {
      userInputs.push({ step: s.step_index, chars: content.length });
      if (content.includes('changed setting `Model Selection`')) {
        const m = content.match(MODEL_RE);
        if (m) model = m[1].trim();
      }
    } else if (s.type === 'CHECKPOINT') {
      lastCheckpoint = s.step_index;
      checkpointChars = content.length;
    } else if (s.type === 'PLANNER_RESPONSE') {
      const input = s.input_tokens ?? 0;
      const cache = s.cache_read_tokens ?? 0;
      const thinking = typeof s.thinking === 'string' ? s.thinking : '';
      const calls = (s.tool_calls ?? []).map(tc => {
        const args = Object.fromEntries(
          Object.entries(tc.args ?? {}).map(([k, v]) => [k, decodeArg(v)])
        );
        return {
          step: s.step_index,
          name: tc.name,
          summary: String(args.toolSummary || args.toolAction || tc.name),
          argsChars: JSON.stringify(args).length,
          outputChars: 0
        };
      });
      toolCalls.push(...calls);
      pending = [...calls];
      requests.push({
        step: s.step_index,
        input,
        cache,
        output: s.output_tokens ?? 0,
        context: input + cache,
        contentChars: content.length + thinking.length,
        argsChars: calls.reduce((sum, c) => sum + c.argsChars, 0)
      });
    } else if (s.type === 'GENERIC') {
      const call = pending.shift();
      if (call) call.outputChars = content.length;
    }
  }
  return { steps, requests, userInputs, toolCalls, lastCheckpoint, checkpointChars, model };
}
