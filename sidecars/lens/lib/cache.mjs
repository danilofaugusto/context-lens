import { statSync } from 'node:fs';

export function createFileCache(maxEntries = 20) {
  const store = new Map();

  return {
    get(filePath) {
      const entry = store.get(filePath);
      if (!entry) return null;
      try {
        const st = statSync(filePath);
        if (st.mtimeMs === entry.mtimeMs && st.size === entry.size) {
          store.delete(filePath);
          store.set(filePath, entry);
          return entry.data;
        }
      } catch {
        store.delete(filePath);
        return null;
      }
      store.delete(filePath);
      return null;
    },
    set(filePath, stat, data) {
      if (store.has(filePath)) store.delete(filePath);
      while (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
      store.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        data
      });
    },
    clear() {
      store.clear();
    }
  };
}

export function createTtlCache(ttlMs = 30000, maxEntries = 20) {
  const store = new Map();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.data;
    },
    set(key, data, customTtl = ttlMs) {
      if (store.has(key)) store.delete(key);
      while (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
      store.set(key, {
        expiresAt: Date.now() + customTtl,
        data
      });
    },
    clear() {
      store.clear();
    }
  };
}

export function resolveWindow(modelName, config) {
  if (!modelName || !config?.windows) return config?.defaultWindow || 1048576;
  const normalized = String(modelName).toLowerCase();
  let bestMatchKey = null;
  let bestMatchLen = 0;

  for (const key of Object.keys(config.windows)) {
    const keyNorm = key.toLowerCase();
    if (normalized.includes(keyNorm)) {
      if (keyNorm.length > bestMatchLen) {
        bestMatchLen = keyNorm.length;
        bestMatchKey = key;
      }
    }
  }

  if (bestMatchKey) {
    return config.windows[bestMatchKey];
  }
  return config?.defaultWindow || 1048576;
}
