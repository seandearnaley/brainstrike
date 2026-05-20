import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import {
  __resetEmbeddingPreferencesStoreForTests,
  useEmbeddingPreferencesStore,
} from '../stores/embedding-preferences-store';

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
    rehydrate?: () => Promise<void>;
  };
};

const storeWithPersist = useEmbeddingPreferencesStore as PersistApi<
  typeof useEmbeddingPreferencesStore
>;

describe('embedding-preferences-store', () => {
  beforeEach(() => {
    __resetEmbeddingPreferencesStoreForTests();
    storeWithPersist.persist?.clearStorage?.();
  });

  describe('default state', () => {
    it('has browser as default preferred runtime', () => {
      const store = useEmbeddingPreferencesStore.getState();
      expect(store.preferredRuntime).toBe('browser');
    });

    it('has local models enabled by default', () => {
      const store = useEmbeddingPreferencesStore.getState();
      const localModels = store.getEnabledModels('local');
      expect(localModels).toContain('jinaai/jina-embeddings-v2-base-code');
      const transformerModels = store.getEnabledModels('transformers');
      expect(transformerModels).toContain('jinaai/jina-embeddings-v2-base-code');
    });

    it('has hosted providers disabled by default', () => {
      const store = useEmbeddingPreferencesStore.getState();
      expect(store.getEnabledModels('openai')).toEqual([]);
      expect(store.getEnabledModels('google')).toEqual([]);
      expect(store.getEnabledModels('cohere')).toEqual([]);
      expect(store.getEnabledModels('voyage')).toEqual([]);
      expect(store.getEnabledModels('ollama')).toEqual([]);
      expect(store.getEnabledModels('lmstudio')).toEqual([]);
    });
  });

  // Global model selection has been removed; selection is now per-collection/embedding-set.

  describe('model enablement', () => {
    it('enables a model for a provider', () => {
      const store = useEmbeddingPreferencesStore.getState();

      expect(store.getEnabledModels('openai')).toEqual([]);

      store.setModelEnabled('openai', 'text-embedding-3-small', true);

      expect(store.getEnabledModels('openai')).toContain('text-embedding-3-small');
    });

    it('disables a model for a provider', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable then disable
      store.setModelEnabled('local', 'jinaai/jina-embeddings-v2-base-code', true);
      expect(store.getEnabledModels('local')).toContain('jinaai/jina-embeddings-v2-base-code');

      store.setModelEnabled('local', 'jinaai/jina-embeddings-v2-base-code', false);
      expect(store.getEnabledModels('local')).not.toContain('jinaai/jina-embeddings-v2-base-code');
    });

    it('enables multiple models for a provider', () => {
      const store = useEmbeddingPreferencesStore.getState();

      const models = ['text-embedding-3-small', 'text-embedding-3-large'];
      store.setProviderModelsEnabled('openai', models, true);

      const enabled = store.getEnabledModels('openai');
      expect(enabled).toContain('text-embedding-3-small');
      expect(enabled).toContain('text-embedding-3-large');
    });

    it('disables multiple models for a provider', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable multiple
      const models = ['text-embedding-3-small', 'text-embedding-3-large'];
      store.setProviderModelsEnabled('openai', models, true);

      // Disable all
      store.setProviderModelsEnabled('openai', models, false);

      expect(store.getEnabledModels('openai')).toEqual([]);
    });

    it('does not add duplicate models', () => {
      const store = useEmbeddingPreferencesStore.getState();

      store.setModelEnabled('openai', 'text-embedding-3-small', true);
      store.setModelEnabled('openai', 'text-embedding-3-small', true);

      const enabled = store.getEnabledModels('openai');
      const count = enabled.filter((m) => m === 'text-embedding-3-small').length;
      expect(count).toBe(1);
    });
  });

  // Selection and selection interactions removed.

  describe('runtime preference', () => {
    it('sets preferred runtime to hosted', () => {
      const store = useEmbeddingPreferencesStore.getState();

      expect(store.preferredRuntime).toBe('browser');

      store.setPreferredRuntime('hosted');

      const updated = useEmbeddingPreferencesStore.getState();
      expect(updated.preferredRuntime).toBe('hosted');
    });

    it('sets preferred runtime to browser', () => {
      const store = useEmbeddingPreferencesStore.getState();

      store.setPreferredRuntime('hosted');
      const afterHosted = useEmbeddingPreferencesStore.getState();
      expect(afterHosted.preferredRuntime).toBe('hosted');

      store.setPreferredRuntime('browser');
      const afterBrowser = useEmbeddingPreferencesStore.getState();
      expect(afterBrowser.preferredRuntime).toBe('browser');
    });
  });

  describe('persistence', () => {
    it('persists enabled models across store instances', () => {
      const store1 = useEmbeddingPreferencesStore.getState();

      store1.setModelEnabled('openai', 'text-embedding-3-small', true);
      store1.setModelEnabled('openai', 'text-embedding-3-large', true);

      const store2 = useEmbeddingPreferencesStore.getState();

      expect(store2.getEnabledModels('openai')).toContain('text-embedding-3-small');
      expect(store2.getEnabledModels('openai')).toContain('text-embedding-3-large');
    });

    it('persists preferred runtime across store instances', () => {
      const store1 = useEmbeddingPreferencesStore.getState();

      store1.setPreferredRuntime('hosted');

      const store2 = useEmbeddingPreferencesStore.getState();

      expect(store2.preferredRuntime).toBe('hosted');
    });

    it('migrates legacy Google embedding model IDs', async () => {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const legacyState: StorageValue<unknown> = {
        version: 1,
        state: {
          enabledModelsByProvider: {
            local: [],
            transformers: [],
            openai: [],
            google: ['text-embedding-004'],
            cohere: [],
            voyage: [],
            ollama: [],
            lmstudio: [],
          },
          preferredRuntime: 'hosted',
        },
      };

      options.storage.setItem(options.name, legacyState);
      await persistApi.rehydrate?.();

      const store = useEmbeddingPreferencesStore.getState();
      expect(store.getEnabledModels('google')).toContain('gemini-embedding-001');
      expect(store.getEnabledModels('google')).not.toContain('text-embedding-004');
    });
  });

  // Migration tests for legacy selection removed - migration now drops legacy selectedModel.

  describe('edge cases', () => {
    it('returns empty array for unknown provider', () => {
      const store = useEmbeddingPreferencesStore.getState();

      const enabled = store.getEnabledModels('unknown' as EmbeddingProviderType);

      expect(enabled).toEqual([]);
    });

    it('handles empty models array in setProviderModelsEnabled', () => {
      const store = useEmbeddingPreferencesStore.getState();
      const initialState = { ...store };

      store.setProviderModelsEnabled('openai', [], true);

      const finalState = useEmbeddingPreferencesStore.getState();

      // State should be unchanged
      expect(finalState.enabledModelsByProvider).toEqual(initialState.enabledModelsByProvider);
    });
  });

  describe('store versioning', () => {
    it('has correct store name and version', () => {
      const options = storeWithPersist.persist?.getOptions?.();

      expect(options?.name).toBe('embedding-preferences.v1');
    });
  });
});
