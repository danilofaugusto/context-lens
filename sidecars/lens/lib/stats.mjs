import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { computeBreakdown } from './breakdown.mjs';
import { backtest, forecastNext } from './forecast.mjs';
import { resolveWindow } from './cache.mjs';

export function normalizeWorkspaceDirs(workspaceDirs = []) {
  if (!Array.isArray(workspaceDirs)) return [];
  const dirs = [];
  for (const raw of workspaceDirs) {
    if (!raw || typeof raw !== 'string') continue;
    let p = raw.trim();
    if (p.startsWith('file://')) {
      try {
        p = fileURLToPath(p);
      } catch {
        p = p.replace(/^file:\/\/\/?/, '');
      }
    }
    if (p) {
      const resolved = resolve(p);
      if (existsSync(resolved)) {
        dirs.push(resolved);
      }
    }
  }
  return [...new Set(dirs)];
}

export function emptyStatsResponse(config, conversationId, brainPath, warning) {
  return {
    conversationId: conversationId || null,
    brainPath: brainPath || '',
    model: null,
    window: config?.defaultWindow || 1048576,
    total: null,
    free: null,
    lastRequest: null,
    categories: [],
    autocompact: config?.autocompactThreshold ?? null,
    forecast: { next: null, delta: null },
    verification: { forecast: null, actual: null, delta: null, errorPct: null, mape: null, samples: 0 },
    warnings: warning ? [warning] : []
  };
}

export function buildStats(parsed, scanned, config = {}, meta = {}) {
  const breakdown = computeBreakdown(parsed, scanned);
  const modelName = parsed?.model || 'Gemini';
  const defaultWindow = config?.defaultWindow || 1048576;
  const windowTokens = resolveWindow(modelName, config) || defaultWindow;
  const total = breakdown.total;
  const free = total !== null ? Math.max(0, windowTokens - total) : null;

  const validRequests = (parsed?.requests || []).filter(r => r.context > 0);
  const lastReqItem = validRequests.length > 0 ? validRequests[validRequests.length - 1] : null;
  const lastRequest = lastReqItem ? {
    step: lastReqItem.step,
    input: lastReqItem.input,
    cache: lastReqItem.cache,
    output: lastReqItem.output
  } : null;

  const forecast = forecastNext(parsed);
  const verification = backtest(parsed);

  return {
    conversationId: meta.conversationId || null,
    brainPath: meta.brainPath || '',
    model: parsed?.model || null,
    window: windowTokens,
    total,
    free,
    lastRequest,
    categories: breakdown.categories,
    autocompact: config?.autocompactThreshold ?? null,
    forecast,
    verification,
    warnings: breakdown.warnings
  };
}
