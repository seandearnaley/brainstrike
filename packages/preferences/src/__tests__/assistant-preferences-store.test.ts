import {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type SupportedProvider,
} from '@brainstrike/agent/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';

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

const storeWithPersist = useAssistantPreferencesStore as PersistApi<
  typeof useAssistantPreferencesStore
>;

describe('assistant-preferences-store', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
    storeWithPersist.persist?.clearStorage?.();
    vi.restoreAllMocks();
    const secretTarget = window as Window & { secrets?: unknown };
    Reflect.deleteProperty(secretTarget, 'secrets');
  });

  it('returns composite model when set', () => {
    const store = useAssistantPreferencesStore.getState();
    expect(store.selectedModel).toBeNull();
    expect(store.getSelectedModel()).toBeNull();

    const compositeKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    store.setModel(compositeKey);
    expect(store.getSelectedModel()).toBe(compositeKey);
    expect(store.getSelectedProvider()).toBe('openai');
  });

  it('allows overriding models per provider', () => {
    const snapshot = useAssistantPreferencesStore.getState();

    // Use a model that is enabled by default (has default: true in registry)
    const defaultModel = PROVIDER_DEFAULT_MODELS.anthropic!;
    const compositeKey = `anthropic::${defaultModel}`;
    snapshot.setModel(compositeKey);

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe(compositeKey);
    expect(updated.getSelectedProvider()).toBe('anthropic');
    expect(updated.modelsByProvider.anthropic).toBe(defaultModel);
  });

  it('clears selection when the current model is disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    const initialModel = PROVIDER_DEFAULT_MODELS.openai!;
    const compositeKey = `openai::${initialModel}`;

    store.setModel(compositeKey);
    expect(store.getSelectedModel()).toBe(compositeKey);

    store.setModelEnabled('openai', initialModel, false);

    const after = useAssistantPreferencesStore.getState();
    expect(after.getSelectedModel()).toBeNull();
    expect(after.enabledModelsByProvider.openai).not.toContain(initialModel);
  });

  it('clears selection when all models are disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    const compositeKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    store.setModel(compositeKey);

    const enabledModels = store.getEnabledModels('openai');
    expect(enabledModels.length).toBeGreaterThan(0);

    for (const model of enabledModels) {
      store.setModelEnabled('openai', model, false);
    }

    const after = useAssistantPreferencesStore.getState();
    expect(after.selectedModel).toBeNull();
    expect(after.getSelectedModel()).toBeNull();
    expect(after.getEnabledModels('openai')).toEqual([]);
  });

  it('ignores setModel calls for disabled models', () => {
    const store = useAssistantPreferencesStore.getState();

    // Get first enabled model
    const [firstModel] = store.getEnabledModels('google');
    expect(firstModel).toBeDefined();

    // Enable a second model for testing (from the full provider models list)
    const allGoogleModels = PROVIDER_MODELS.google as string[];
    const secondModel = allGoogleModels.find((m) => m !== firstModel);
    expect(secondModel).toBeDefined();
    store.setModelEnabled('google', secondModel!, true);

    // Set second model first
    const validComposite = `google::${secondModel}`;
    store.setModel(validComposite);
    expect(store.getSelectedModel()).toBe(validComposite);

    // Disable first model and try to set it
    store.setModelEnabled('google', firstModel!, false);
    const invalidComposite = `google::${firstModel}`;
    store.setModel(invalidComposite);

    // Should still be the valid one
    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe(validComposite);
  });

  it('resolves available providers from secrets API', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      list: vi.fn().mockResolvedValue(['openai', 'google', 'unknown-provider']),
      saveKey: vi.fn(),
      getKey: vi.fn(),
      deleteKey: vi.fn(),
      listStored: vi.fn(),
      clearAll: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    // 'local' is always included because it doesn't require API keys
    const expected: SupportedProvider[] = ['openai', 'google', 'local'];
    expect(providers).toEqual(expected);
  });

  it('returns only no-key providers when secrets API fails', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      list: vi.fn().mockRejectedValue(new Error('not allowed')),
      saveKey: vi.fn(),
      getKey: vi.fn(),
      deleteKey: vi.fn(),
      listStored: vi.fn(),
      clearAll: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    // 'local' doesn't require API keys, so it's still available when secrets API fails
    expect(providers).toEqual(['local']);
  });

  it('updates model with composite key', () => {
    const store = useAssistantPreferencesStore.getState();

    // Initially no model selected
    expect(store.selectedModel).toBeNull();
    expect(store.getSelectedModel()).toBeNull();

    // Select anthropic with the default model using composite key
    const defaultModel = PROVIDER_DEFAULT_MODELS.anthropic!;
    const compositeKey = `anthropic::${defaultModel}`;
    store.setModel(compositeKey);

    const updated = useAssistantPreferencesStore.getState();

    // Model should be selected with composite key
    expect(updated.selectedModel).toBe(compositeKey);
    expect(updated.getSelectedProvider()).toBe('anthropic');
    expect(updated.modelsByProvider.anthropic).toBe(defaultModel);
    expect(updated.getSelectedModel()).toBe(compositeKey);
  });

  it('switches between providers using composite keys', () => {
    const initialStore = useAssistantPreferencesStore.getState();

    // Start with openai
    const openaiKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    initialStore.setModel(openaiKey);

    const withOpenAI = useAssistantPreferencesStore.getState();
    expect(withOpenAI.selectedModel).toBe(openaiKey);
    expect(withOpenAI.getSelectedProvider()).toBe('openai');

    // Get an enabled model for Google
    const [firstGoogleModel, secondGoogleModel] = initialStore.getEnabledModels('google');
    const googleModel = secondGoogleModel ?? firstGoogleModel!;
    expect(googleModel).toBeDefined();

    // Switch to google with a specific model using composite key
    const googleKey = `google::${googleModel}`;
    withOpenAI.setModel(googleKey);

    // Get fresh state
    const updated = useAssistantPreferencesStore.getState();

    // Both should switch
    expect(updated.selectedModel).toBe(googleKey);
    expect(updated.getSelectedProvider()).toBe('google');
    expect(updated.modelsByProvider.google).toBe(googleModel);
    expect(updated.getSelectedModel()).toBe(googleKey);

    // Old provider's model should still be preserved
    expect(updated.modelsByProvider.openai).toBe(PROVIDER_DEFAULT_MODELS.openai);
  });

  it('persists to in-memory storage when localStorage is unavailable', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    const store = useAssistantPreferencesStore.getState();
    const compositeKey = 'openrouter::gpt-4o-mini';
    store.setModel(compositeKey);

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
        selectedModel: string | null;
        modelsByProvider: Record<SupportedProvider, string>;
        enabledModelsByProvider: Record<SupportedProvider, string[]>;
      };
    };

    expect(snapshot.state?.selectedModel).toBe(compositeKey);
    expect(snapshot.state?.modelsByProvider.openrouter).toBe('gpt-4o-mini');
    // Only models with default: true are enabled by default, not all PROVIDER_MODELS
    expect(snapshot.state?.enabledModelsByProvider.openrouter).toContain('gpt-4o-mini');

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });
});
