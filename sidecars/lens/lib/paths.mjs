import { resolve, sep } from 'node:path';

export const SAFE_CONV_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function resolveSafeBrainPath(brainBase, conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  if (!SAFE_CONV_ID_RE.test(conversationId)) return null;
  const resolvedBase = resolve(brainBase);
  const safePrefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  const candidate = resolve(resolvedBase, conversationId);
  const isWin = process.platform === 'win32';
  const candNorm = isWin ? candidate.toLowerCase() : candidate;
  const prefNorm = isWin ? safePrefix.toLowerCase() : safePrefix;
  if (!candNorm.startsWith(prefNorm)) return null;
  return candidate;
}
