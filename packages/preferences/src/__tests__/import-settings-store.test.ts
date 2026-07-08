import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetImportSettingsStoreForTests,
  importSettingsSelectors,
  useImportSettingsStore,
} from '../stores/import-settings-store';
import {
  __resetTokenPreferencesStoreForTests,
  useTokenPreferencesStore,
} from '../stores/token-preferences-store';

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

const storeWithPersist = useImportSettingsStore as PersistApi<typeof useImportSettingsStore>;

describe('import-settings-store', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    __resetImportSettingsStoreForTests();
    vi.restoreAllMocks();
  });

  it('initializes with default configuration', () => {
    const store = useImportSettingsStore.getState();
    expect(store.enableChunking).toBe(true);
    expect(store.chunkingPreset).toBe('balanced');
    expect(store.chunkingStrategy).toBe('auto');
    expect(store.chunkingStrategyExplicit).toBe(false);
    expect(store.chunkSize).toBe(256);
    expect(store.chunkOverlap).toBe(50);
    expect(store.tokenTrueSizing).toBe(true);
    expect(store.chunkTokenLimit).toBe(4096);
  });

  it('normalizes chunk settings', () => {
    const snapshot = useImportSettingsStore.getState();

    snapshot.setChunkSize(-42.7);
    snapshot.setChunkOverlap(-9.4);
    snapshot.setTokenTrueSizing(0 as unknown as boolean);
    snapshot.setChunkTokenLimit(99_999);

    const next = useImportSettingsStore.getState();
    expect(next.chunkSize).toBe(1);
    expect(next.chunkOverlap).toBe(0);
    expect(next.tokenTrueSizing).toBe(false);
    expect(next.chunkTokenLimit).toBe(16_384);
    expect(useTokenPreferencesStore.getState().accurateCounting).toBe(false);
  });

  it('updates selectors in response to state changes', () => {
    const snapshot = useImportSettingsStore.getState();
    snapshot.setEnableChunking(false);
    snapshot.setChunkingStrategy('recursive');
    snapshot.setChunkSize(512);
    snapshot.setChunkOverlap(24);
    snapshot.setTokenTrueSizing(false);
    snapshot.setChunkTokenLimit(2048);

    const next = useImportSettingsStore.getState();
    expect(next.chunkingStrategyExplicit).toBe(true);
    const chunking = importSettingsSelectors.chunking(next);
    const sizes = importSettingsSelectors.sizes(next);
    const sizing = importSettingsSelectors.tokenSizing(next);
    const limit = importSettingsSelectors.tokenLimit(next);

    expect(chunking).toEqual([false, 'recursive']);
    expect(sizes).toEqual([512, 24]);
    expect(sizing).toBe(false);
    expect(limit).toBe(2048);
  });

  it('hydrates preset values and promotes to custom when manually tuned', () => {
    const snapshot = useImportSettingsStore.getState();

    snapshot.setChunkingPreset('docs');
    let next = useImportSettingsStore.getState();
    expect(next.chunkingPreset).toBe('docs');
    expect(next.chunkingStrategy).toBe('semantic-markdown');
    expect(next.chunkingStrategyExplicit).toBe(true);
    expect(next.chunkSize).toBe(320);
    expect(next.chunkOverlap).toBe(56);
    expect(next.chunkTokenLimit).toBe(4096);

    next.setChunkSize(640);
    next = useImportSettingsStore.getState();
    expect(next.chunkingPreset).toBe('custom');
    expect(next.chunkSize).toBe(640);
  });

  it('keeps manually selected auto strategy explicit', () => {
    useImportSettingsStore.getState().setChunkingStrategy('auto');

    const next = useImportSettingsStore.getState();
    expect(next.chunkingPreset).toBe('custom');
    expect(next.chunkingStrategy).toBe('auto');
    expect(next.chunkingStrategyExplicit).toBe(true);
  });

  it('persists via in-memory storage if localStorage throws', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const store = useImportSettingsStore.getState();
    store.setEnableChunking(false);
    store.setChunkSize(128);

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
        enableChunking: boolean;
        chunkingPreset: string;
        chunkSize: number;
        chunkingStrategyExplicit: boolean;
        chunkingStrategy: string;
        tokenTrueSizing?: boolean;
        chunkTokenLimit?: number;
      };
    };

    expect(snapshot.state?.enableChunking).toBe(false);
    expect(snapshot.state?.chunkingPreset).toBe('custom');
    expect(snapshot.state?.chunkingStrategy).toBe('auto');
    expect(snapshot.state?.chunkSize).toBe(128);
    expect(snapshot.state?.chunkingStrategyExplicit).toBe(false);
    expect(snapshot.state?.tokenTrueSizing).toBe(true);
    expect(snapshot.state?.chunkTokenLimit).toBe(4096);

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });

  it('rebinds token preference synchronization during test resets', () => {
    useTokenPreferencesStore.getState().setAccurateCounting(false);
    expect(useImportSettingsStore.getState().tokenTrueSizing).toBe(false);

    __resetImportSettingsStoreForTests();

    useTokenPreferencesStore.getState().setAccurateCounting(false);
    expect(useImportSettingsStore.getState().tokenTrueSizing).toBe(false);
  });

  it('preserves tuned numeric chunk settings when migrating legacy preset snapshots', () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    options.storage.setItem(options.name, {
      state: {
        chunkingPreset: 'docs',
        chunkingStrategy: 'semantic-markdown',
        chunkingStrategyExplicit: true,
        chunkOverlap: 33,
        chunkSize: 777,
        chunkTokenLimit: 5555,
        enableChunking: true,
        tokenTrueSizing: true,
      },
      version: 6,
    });

    const migrated = (
      useImportSettingsStore as unknown as {
        persist?: { rehydrate?: () => Promise<void> };
      }
    ).persist;

    return migrated?.rehydrate?.().then(() => {
      const next = useImportSettingsStore.getState();
      expect(next.chunkingPreset).toBe('docs');
      expect(next.chunkingStrategy).toBe('semantic-markdown');
      expect(next.chunkSize).toBe(777);
      expect(next.chunkOverlap).toBe(33);
      expect(next.chunkTokenLimit).toBe(5555);
    });
  });

  it('promotes legacy snapshots without an explicit preset to custom when tuned values differ', () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    options.storage.setItem(options.name, {
      state: {
        chunkOverlap: 33,
        chunkSize: 777,
        chunkTokenLimit: 5555,
        enableChunking: true,
        tokenTrueSizing: true,
      },
      version: 6,
    });

    const migrated = (
      useImportSettingsStore as unknown as {
        persist?: { rehydrate?: () => Promise<void> };
      }
    ).persist;

    return migrated?.rehydrate?.().then(() => {
      const next = useImportSettingsStore.getState();
      expect(next.chunkingPreset).toBe('custom');
      expect(next.chunkingStrategy).toBe('auto');
      expect(next.chunkingStrategyExplicit).toBe(false);
      expect(next.chunkSize).toBe(777);
      expect(next.chunkOverlap).toBe(33);
      expect(next.chunkTokenLimit).toBe(5555);
    });
  });
});
