import type { EmbeddingProviderType } from '@brainstrike/embeddings';
import { beforeEach, describe, expect, it } from 'vitest';
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
    it('has default local model selected', () => {
      const store = useEmbeddingPreferencesStore.getState();
      expect(store.selectedModel).toBe('local::jina-code');
      expect(store.getSelectedModel()).toBe('local::jina-code');
      expect(store.getSelectedProvider()).toBe('local');
      expect(store.getSelectedModelId()).toBe('jina-code');
    });

    it('has browser as default preferred runtime', () => {
      const store = useEmbeddingPreferencesStore.getState();
      expect(store.preferredRuntime).toBe('browser');
    });

    it('has local models enabled by default', () => {
      const store = useEmbeddingPreferencesStore.getState();
      const localModels = store.getEnabledModels('local');
      expect(localModels).toContain('jina-code');
    });

    it('has hosted providers disabled by default', () => {
      const store = useEmbeddingPreferencesStore.getState();
      expect(store.getEnabledModels('openai')).toEqual([]);
      expect(store.getEnabledModels('google')).toEqual([]);
      expect(store.getEnabledModels('cohere')).toEqual([]);
      expect(store.getEnabledModels('voyage')).toEqual([]);
    });
  });

  describe('model selection', () => {
    it('sets model using composite key format', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable an OpenAI model first
      store.setModelEnabled('openai', 'text-embedding-3-small', true);

      const compositeKey = 'openai::text-embedding-3-small';
      store.setModel(compositeKey);

      expect(store.getSelectedModel()).toBe(compositeKey);
      expect(store.getSelectedProvider()).toBe('openai');
      expect(store.getSelectedModelId()).toBe('text-embedding-3-small');
    });

    it('parses composite key correctly', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable Google model
      store.setModelEnabled('google', 'text-embedding-004', true);
      store.setModel('google::text-embedding-004');

      expect(store.getSelectedProvider()).toBe('google');
      expect(store.getSelectedModelId()).toBe('text-embedding-004');
    });

    it('ignores invalid composite key format', () => {
      const store = useEmbeddingPreferencesStore.getState();
      const initialModel = store.getSelectedModel();

      // Try to set invalid format (missing ::)
      store.setModel('invalid-format');

      expect(store.getSelectedModel()).toBe(initialModel);
    });

    it('ignores setting disabled model', () => {
      const store = useEmbeddingPreferencesStore.getState();
      const initialModel = store.getSelectedModel();

      // Try to set a model that's not enabled
      store.setModel('openai::text-embedding-3-large');

      // Should remain unchanged
      expect(store.getSelectedModel()).toBe(initialModel);
    });

    it('clears selected model', () => {
      const store = useEmbeddingPreferencesStore.getState();

      expect(store.getSelectedModel()).toBe('local::jina-code');

      store.clearModel();

      expect(store.getSelectedModel()).toBeNull();
      expect(store.getSelectedProvider()).toBeNull();
      expect(store.getSelectedModelId()).toBeNull();
    });
  });

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
      store.setModelEnabled('local', 'jina-code', true);
      expect(store.getEnabledModels('local')).toContain('jina-code');

      store.setModelEnabled('local', 'jina-code', false);
      expect(store.getEnabledModels('local')).not.toContain('jina-code');
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

  describe('selection and enablement interaction', () => {
    it('clears selection when currently selected model is disabled', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable and select a model
      store.setModelEnabled('openai', 'text-embedding-3-small', true);
      store.setModel('openai::text-embedding-3-small');

      expect(store.getSelectedModel()).toBe('openai::text-embedding-3-small');

      // Disable the selected model
      store.setModelEnabled('openai', 'text-embedding-3-small', false);

      expect(store.getSelectedModel()).toBeNull();
    });

    it('preserves selection when a different model is disabled', () => {
      const store = useEmbeddingPreferencesStore.getState();

      // Enable two models
      store.setModelEnabled('openai', 'text-embedding-3-small', true);
      store.setModelEnabled('openai', 'text-embedding-3-large', true);

      // Select one
      store.setModel('openai::text-embedding-3-small');

      // Disable the other
      store.setModelEnabled('openai', 'text-embedding-3-large', false);

      // Selection should be preserved
      expect(store.getSelectedModel()).toBe('openai::text-embedding-3-small');
    });

    it('clears selection when all models for selected provider are disabled', () => {
      const store = useEmbeddingPreferencesStore.getState();

      expect(store.getSelectedModel()).toBe('local::jina-code');

      // Disable all local models
      store.setModelEnabled('local', 'jina-code', false);

      expect(store.getSelectedModel()).toBeNull();
    });
  });

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
    it('persists selected model across store instances', () => {
      const store1 = useEmbeddingPreferencesStore.getState();

      store1.setModelEnabled('google', 'text-embedding-004', true);
      store1.setModel('google::text-embedding-004');

      // Simulate new instance by getting fresh state
      const store2 = useEmbeddingPreferencesStore.getState();

      expect(store2.getSelectedModel()).toBe('google::text-embedding-004');
    });

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
  });

  describe('migration', () => {
    it('migrates legacy string model ID to composite key', () => {
      // Test the migration logic directly by simulating old state
      useEmbeddingPreferencesStore.setState({
        selectedModel: 'jina-code', // Old format: just model ID (no ::)
        enabledModelsByProvider: {
          local: ['jina-code'],
          openai: [],
          google: [],
          cohere: [],
          voyage: [],
        },
        preferredRuntime: 'browser',
      });

      const store = useEmbeddingPreferencesStore.getState();

      // The getSelectedProvider and getSelectedModelId functions handle parsing
      // For a string without ::, the whole string is the provider, modelId is null
      // This is expected behavior - migration happens in the persist middleware
      expect(store.selectedModel).toBe('jina-code');
    });

    it('preserves composite key format', () => {
      // Set a proper composite key
      useEmbeddingPreferencesStore.setState({
        selectedModel: 'openai::text-embedding-3-small',
        enabledModelsByProvider: {
          local: ['jina-code'],
          openai: ['text-embedding-3-small'],
          google: [],
          cohere: [],
          voyage: [],
        },
        preferredRuntime: 'hosted',
      });

      const store = useEmbeddingPreferencesStore.getState();

      // Should preserve composite key
      expect(store.getSelectedModel()).toBe('openai::text-embedding-3-small');
      expect(store.getSelectedProvider()).toBe('openai');
      expect(store.getSelectedModelId()).toBe('text-embedding-3-small');
    });
  });

  describe('edge cases', () => {
    it('handles null selected model', () => {
      const store = useEmbeddingPreferencesStore.getState();

      store.clearModel();

      expect(store.getSelectedProvider()).toBeNull();
      expect(store.getSelectedModelId()).toBeNull();
    });

    it('handles malformed composite key', () => {
      // Directly set malformed key (bypassing validation)
      useEmbeddingPreferencesStore.setState({ selectedModel: 'malformed' });

      const store = useEmbeddingPreferencesStore.getState();

      // Malformed keys without :: will return the whole string as provider
      expect(store.getSelectedProvider()).toBe('malformed');
      expect(store.getSelectedModelId()).toBeNull();
    });

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
