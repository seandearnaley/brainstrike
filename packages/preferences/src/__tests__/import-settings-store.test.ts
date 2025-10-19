import { SimpleEmbeddingService } from '@brainstrike/embeddings';
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
    expect(store.chunkingStrategy).toBe('sentence');
    expect(store.chunkingStrategyExplicit).toBe(false);
    expect(store.chunkSize).toBe(256);
    expect(store.chunkOverlap).toBe(50);
    expect(store.tokenTrueSizing).toBe(true);
    expect(store.chunkTokenLimit).toBe(4096);
    expect(store.enableEmbedding).toBe(false);
    expect(store.selectedModel).toBe(SimpleEmbeddingService.getDefaultModelKey());
  });

  it('normalizes chunk settings and embedding toggle', () => {
    const snapshot = useImportSettingsStore.getState();

    snapshot.setChunkSize(-42.7);
    snapshot.setChunkOverlap(-9.4);
    snapshot.setEnableEmbedding(1 as unknown as boolean);
    snapshot.setTokenTrueSizing(0 as unknown as boolean);
    snapshot.setChunkTokenLimit(99999);

    const next = useImportSettingsStore.getState();
    expect(next.chunkSize).toBe(1);
    expect(next.chunkOverlap).toBe(0);
    expect(next.tokenTrueSizing).toBe(false);
    expect(next.chunkTokenLimit).toBe(16384);
    expect(next.enableEmbedding).toBe(true);
    expect(useTokenPreferencesStore.getState().accurateCounting).toBe(false);
  });

  it('updates selectors in response to state changes', () => {
    const snapshot = useImportSettingsStore.getState();
    snapshot.setEnableChunking(false);
    snapshot.setChunkingStrategy('recursive' as const);
    snapshot.setChunkSize(512);
    snapshot.setChunkOverlap(24);
    snapshot.setTokenTrueSizing(false);
    snapshot.setChunkTokenLimit(2048);
    snapshot.setEnableEmbedding(true);
    snapshot.setSelectedModel('test-model');

    const next = useImportSettingsStore.getState();
    expect(next.chunkingStrategyExplicit).toBe(true);
    const chunking = importSettingsSelectors.chunking(next);
    const sizes = importSettingsSelectors.sizes(next);
    const sizing = importSettingsSelectors.tokenSizing(next);
    const limit = importSettingsSelectors.tokenLimit(next);
    const embedding = importSettingsSelectors.embedding(next);

    expect(chunking).toEqual([false, 'recursive']);
    expect(sizes).toEqual([512, 24]);
    expect(sizing).toBe(false);
    expect(limit).toBe(2048);
    expect(embedding).toEqual([true, 'test-model']);
  });

  it('persists via in-memory storage if localStorage throws', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!persistApi || !options?.storage || !options.name) {
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
        chunkSize: number;
        chunkingStrategyExplicit: boolean;
        tokenTrueSizing?: boolean;
        chunkTokenLimit?: number;
      };
    };

    expect(snapshot.state?.enableChunking).toBe(false);
    expect(snapshot.state?.chunkSize).toBe(128);
    expect(snapshot.state?.chunkingStrategyExplicit).toBe(false);
    expect(snapshot.state?.tokenTrueSizing).toBe(true);
    expect(snapshot.state?.chunkTokenLimit).toBe(4096);

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });
});
