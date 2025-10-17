import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVectorPreferencesStore } from '../stores/vector-preferences-store';

type PersistApi<T> = T & {
  persist?: {
    getOptions?: () => {
      name: string;
      storage: {
        getItem: (name: string) => string | null;
        setItem: (name: string, value: string) => void;
        removeItem: (name: string) => void;
      };
    };
    clearStorage?: () => void;
  };
};

const storeWithPersist = useVectorPreferencesStore as PersistApi<typeof useVectorPreferencesStore>;

describe('vector-preferences-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const store = useVectorPreferencesStore;
    store.setState({
      devicePref: 'auto',
      reinitEveryN: 200,
      forceCpuAfterFailures: 3,
      verboseOrtLogs: false,
    });
    storeWithPersist.persist?.clearStorage?.();
  });

  it('initializes with defaults and updates device preference', () => {
    expect(useVectorPreferencesStore.getState().devicePref).toBe('auto');
    useVectorPreferencesStore.getState().setDevicePref('webgpu');
    expect(useVectorPreferencesStore.getState().devicePref).toBe('webgpu');
  });

  it('clamps numeric preferences to safe ranges', () => {
    const store = useVectorPreferencesStore.getState();
    store.setReinitEveryN(0.2);
    store.setForceCpuAfterFailures(-3.7);
    store.setVerboseOrtLogs('yes' as unknown as boolean);

    const next = useVectorPreferencesStore.getState();
    expect(next.reinitEveryN).toBe(1);
    expect(next.forceCpuAfterFailures).toBe(0);
    expect(next.verboseOrtLogs).toBe(true);
  });

  it('persists through fallback storage when localStorage fails', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!persistApi || !options?.storage || !options.name) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const store = useVectorPreferencesStore.getState();
    store.setDevicePref('cpu');
    store.setReinitEveryN(16);

    const persistedValue = storage.getItem(options.name)!;
    expect(persistedValue).not.toBeNull();

    if (
      !persistedValue ||
      typeof (persistedValue as { state?: unknown }) !== 'object' ||
      Array.isArray(persistedValue)
    ) {
      throw new Error('unexpected persisted snapshot');
    }

    const snapshot = persistedValue as {
      state?: {
        devicePref: string;
        reinitEveryN: number;
      };
    };

    expect(snapshot.state?.devicePref).toBe('cpu');
    expect(snapshot.state?.reinitEveryN).toBe(16);

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });
});
