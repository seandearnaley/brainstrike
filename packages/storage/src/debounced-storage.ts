import type { SafeJsonStateStorage } from './safe-storage.js';

export interface DebouncedStorageAdapter extends SafeJsonStateStorage {
  /** Persist every currently buffered value immediately. */
  flush: () => void;
}

export interface DebouncedStorageAdapterOptions {
  readonly delayMs: number;
}

interface PendingWrite {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly value: string;
}

/**
 * Coalesce synchronous storage writes by key while preserving read-after-write
 * consistency for consumers such as Zustand hydration.
 */
export function createDebouncedStorageAdapter(
  inner: SafeJsonStateStorage,
  options: DebouncedStorageAdapterOptions
): DebouncedStorageAdapter {
  if (!(Number.isFinite(options.delayMs) && options.delayMs >= 0)) {
    throw new RangeError('delayMs must be a finite, non-negative number');
  }

  const pendingWrites = new Map<string, PendingWrite>();

  const flushKey = (key: string): void => {
    const pending = pendingWrites.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    inner.setItem(key, pending.value);
    if (pendingWrites.get(key) === pending) {
      pendingWrites.delete(key);
    }
  };

  const flush = (): void => {
    for (const key of Array.from(pendingWrites.keys())) {
      flushKey(key);
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flush();
        }
      });
    }
  }

  return {
    flush,
    getItem: (key) => pendingWrites.get(key)?.value ?? inner.getItem(key),
    removeItem: (key) => {
      const pending = pendingWrites.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pendingWrites.delete(key);
      }
      inner.removeItem(key);
    },
    setItem: (key, value) => {
      const pending = pendingWrites.get(key);
      if (pending) {
        clearTimeout(pending.timer);
      }
      const timer = setTimeout(() => flushKey(key), options.delayMs);
      pendingWrites.set(key, { timer, value });
    },
  };
}
