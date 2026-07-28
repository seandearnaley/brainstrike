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

  // BST-423. This test previously asserted the OPPOSITE — that `setChunkSize(-42.7)`
  // silently became 1 and `setChunkTokenLimit(99_999)` silently became 16_384. That
  // is the defect the ticket names: the store clamped impossible input into a nearby
  // possible value, so a user who typed 99999 got 16384 with no indication their
  // input was discarded. The assertions are inverted deliberately.
  it('rejects impossible chunk settings instead of clamping them', () => {
    const snapshot = useImportSettingsStore.getState();

    expect(() => snapshot.setChunkSize(-42.7)).toThrow(/Chunk size/);
    expect(() => snapshot.setChunkOverlap(-9.4)).toThrow(/Overlap/);
    expect(() => snapshot.setChunkTokenLimit(99_999)).toThrow(/Token cap/);
    expect(() => snapshot.setChunkSize(Number.NaN)).toThrow(/Chunk size/);

    // A rejected write leaves the previous good value untouched — no partial
    // application, no drift toward the bound.
    const next = useImportSettingsStore.getState();
    expect(next.chunkSize).toBe(256);
    expect(next.chunkOverlap).toBe(50);
    expect(next.chunkTokenLimit).toBe(4096);
  });

  it('rejects a write that would violate the cross-field overlap invariant', () => {
    const snapshot = useImportSettingsStore.getState();
    // Each value is individually in range; only the pair is impossible.
    expect(() => snapshot.setChunkOverlap(256)).toThrow(/smaller than chunk size/);
    // Shrinking size below the CURRENT overlap is the same violation from the
    // other side, and was equally unguarded.
    expect(() => snapshot.setChunkSize(128)).not.toThrow(); // 50 < 128, still fine
    useImportSettingsStore.getState().setChunkOverlap(100);
    expect(() => useImportSettingsStore.getState().setChunkSize(64)).toThrow(
      /smaller than chunk size|at least/
    );
    expect(useImportSettingsStore.getState().chunkOverlap).toBe(100);
  });

  it('still accepts legitimate boolean coercion for token sizing', () => {
    const snapshot = useImportSettingsStore.getState();
    snapshot.setTokenTrueSizing(0 as unknown as boolean);
    expect(useImportSettingsStore.getState().tokenTrueSizing).toBe(false);
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

  // BST-423 — hydration of ALREADY-invalid persisted state.
  //
  // Someone whose localStorage predates these invariants (or who edited it by
  // hand) must not be locked out: throwing here would leave them unable to open
  // Settings to fix it, with factory reset as the only exit. So hydration
  // REPAIRS to the preset default — but records a visible notice, because a
  // silent repair is the same silent normalization this ticket removes.
  //
  // Note the persisted version is the CURRENT one: zustand skips `migrate`
  // entirely when versions match, so the repair cannot live there. It runs on
  // rehydrate, which always executes.
  function persistState(state: Record<string, unknown>, version: number) {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }
    options.storage.setItem(options.name, { state, version });
    return (useImportSettingsStore as unknown as { persist?: { rehydrate?: () => Promise<void> } })
      .persist;
  }

  it('repairs invalid persisted chunk settings to preset defaults and reports it', () => {
    const persistApi = persistState(
      {
        chunkingPreset: 'balanced',
        chunkingStrategy: 'auto',
        chunkingStrategyExplicit: false,
        // overlap > size: each field plausible on its own, the pair impossible.
        chunkOverlap: 900,
        chunkSize: 4,
        chunkTokenLimit: 4096,
        enableChunking: true,
        tokenTrueSizing: true,
      },
      7
    );

    return persistApi?.rehydrate?.().then(() => {
      const next = useImportSettingsStore.getState();
      // Repaired to the balanced preset's values, not clamped to the bounds.
      expect(next.chunkSize).toBe(256);
      expect(next.chunkOverlap).toBe(50);

      // ...and the repair is visible, naming what was discarded.
      expect(next.chunkingSettingsRepairs.length).toBeGreaterThan(0);
      const fields = next.chunkingSettingsRepairs.map((repair) => repair.field);
      expect(fields).toContain('chunkSize');
      const sizeRepair = next.chunkingSettingsRepairs.find(
        (repair) => repair.field === 'chunkSize'
      );
      expect(sizeRepair?.discardedValue).toBe(4);
      expect(sizeRepair?.repairedTo).toBe(256);
      expect(sizeRepair?.message).toMatch(/Chunk size/);
    });
  });

  it('leaves valid persisted settings alone and reports no repair', () => {
    // Control: proves the repair path is not firing indiscriminately. Without
    // this, a bug that repaired everything would still pass the test above.
    const persistApi = persistState(
      {
        chunkingPreset: 'custom',
        chunkingStrategy: 'recursive',
        chunkingStrategyExplicit: true,
        chunkOverlap: 33,
        chunkSize: 777,
        chunkTokenLimit: 5555,
        enableChunking: true,
        tokenTrueSizing: true,
      },
      7
    );

    return persistApi?.rehydrate?.().then(() => {
      const next = useImportSettingsStore.getState();
      expect(next.chunkSize).toBe(777);
      expect(next.chunkOverlap).toBe(33);
      expect(next.chunkTokenLimit).toBe(5555);
      expect(next.chunkingSettingsRepairs).toEqual([]);
    });
  });

  it('lets the user dismiss the repair notice', () => {
    const persistApi = persistState(
      {
        chunkingPreset: 'balanced',
        chunkOverlap: 50,
        chunkSize: 5,
        chunkTokenLimit: 4096,
        enableChunking: true,
        tokenTrueSizing: true,
      },
      7
    );

    return persistApi?.rehydrate?.().then(() => {
      expect(useImportSettingsStore.getState().chunkingSettingsRepairs.length).toBeGreaterThan(0);
      useImportSettingsStore.getState().dismissChunkingSettingsRepairs();
      expect(useImportSettingsStore.getState().chunkingSettingsRepairs).toEqual([]);
    });
  });

  it('never persists the repair notice back to storage', () => {
    // The notice is a one-time, in-session signal. Persisting it would make the
    // warning immortal: it would reappear on every launch forever, long after
    // the settings were corrected.
    const options = storeWithPersist.persist?.getOptions?.();
    const partialized = (
      options as unknown as {
        partialize?: (state: Record<string, unknown>) => Record<string, unknown>;
      }
    ).partialize?.({
      ...useImportSettingsStore.getState(),
      chunkingSettingsRepairs: [{ field: 'chunkSize' }],
    } as unknown as Record<string, unknown>);
    expect(partialized).toBeDefined();
    expect(Object.keys(partialized ?? {})).not.toContain('chunkingSettingsRepairs');
  });
});
