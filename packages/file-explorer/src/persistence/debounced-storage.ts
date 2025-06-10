export interface DebouncedStorageOptions {
  debounceMs?: number;
  flushOnBeforeUnload?: boolean;
}

export function createDebouncedStorage(
  adapter: import('@brainstrike/storage').StorageAdapter,
  options: DebouncedStorageOptions = {}
) {
  const { debounceMs = 200, flushOnBeforeUnload = false } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingKey: string | null = null;
  let pendingValue: string | null = null;

  const flush = async () => {
    const key = pendingKey;
    const value = pendingValue;
    pendingKey = null;
    pendingValue = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (key === null || value === null) return;
    try {
      await adapter.setItem(key, value);
    } catch {
      // ignore adapter errors
    }
  };

  if (flushOnBeforeUnload && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (pendingKey !== null && pendingValue !== null) {
        try {
          localStorage.setItem(pendingKey, pendingValue);
        } catch {
          // ignore
        }
      }
    });
  }

  const debouncedAdapter: import('@brainstrike/storage').StorageAdapter & {
    flush: () => Promise<void>;
  } = {
    ...adapter,
    async setItem(key: string, value: string) {
      pendingKey = key;
      pendingValue = value;
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          flush().then(resolve);
        }, debounceMs);
      });
    },
    flush,
  };

  return debouncedAdapter;
}
