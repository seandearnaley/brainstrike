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
    const secretTarget = window as Window & { secrets?: { list?: () => Promise<string[]> } };
    Reflect.deleteProperty(secretTarget, 'secrets');
  });

  it('returns default model when provider is selected without override', () => {
    const store = useAssistantPreferencesStore.getState();
    expect(store.selectedProvider).toBeNull();
    expect(store.getSelectedModel()).toBeNull();

    store.setProvider('openai');
    expect(store.getSelectedModel()).toBe(PROVIDER_DEFAULT_MODELS.openai);
  });

  it('allows overriding models per provider', () => {
    const snapshot = useAssistantPreferencesStore.getState();

    snapshot.setProvider('anthropic');
    snapshot.setModel('anthropic', 'claude-3-5-sonnet-latest');

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe('claude-3-5-sonnet-latest');
    expect(updated.modelsByProvider.anthropic).toBe('claude-3-5-sonnet-latest');
  });

  it('selects fallback model when the current model is disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    store.setProvider('openai');

    const initialModel = store.getSelectedModel();
    expect(initialModel).toBe(PROVIDER_DEFAULT_MODELS.openai);

    store.setModelEnabled('openai', initialModel!, false);

    const after = useAssistantPreferencesStore.getState();
    const fallback = after.getSelectedModel();
    expect(fallback).toBeDefined();
    expect(fallback).not.toBe(initialModel);
    expect(after.enabledModelsByProvider.openai).not.toContain(initialModel);
  });

  it('clears provider selection when all models are disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    store.setProvider('openai');

    const enabledModels = store.getEnabledModels('openai');
    expect(enabledModels.length).toBeGreaterThan(0);

    for (const model of enabledModels) {
      store.setModelEnabled('openai', model, false);
    }

    const after = useAssistantPreferencesStore.getState();
    expect(after.selectedProvider).toBeNull();
    expect(after.getSelectedModel()).toBeNull();
    expect(after.getEnabledModels('openai')).toEqual([]);
  });

  it('ignores setModel calls for disabled models', () => {
    const store = useAssistantPreferencesStore.getState();
    store.setProvider('google');

    const [firstModel, secondModel] = store.getEnabledModels('google');
    expect(firstModel).toBeDefined();
    expect(secondModel).toBeDefined();

    store.setModelEnabled('google', firstModel!, false);
    store.setModel('google', firstModel!);

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe(secondModel);
  });

  it('resolves available providers from secrets API', async () => {
    const secretTarget = window as Window & { secrets?: { list?: () => Promise<string[]> } };
    secretTarget.secrets = {
      list: vi.fn().mockResolvedValue(['openai', 'google', 'unknown-provider']),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    const expected: SupportedProvider[] = ['openai', 'google'];
    expect(providers).toEqual(expected);
  });

  it('returns empty providers when secrets API fails', async () => {
    const secretTarget = window as Window & { secrets?: { list?: () => Promise<string[]> } };
    secretTarget.secrets = {
      list: vi.fn().mockRejectedValue(new Error('not allowed')),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    expect(providers).toEqual([]);
  });

  it('persists to in-memory storage when localStorage is unavailable', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!persistApi || !options?.storage || !options.name) {
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
    store.setProvider('openrouter');
    store.setModel('openrouter', 'gpt-4o-mini');

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
        selectedProvider: SupportedProvider | null;
        modelsByProvider: Record<SupportedProvider, string>;
        enabledModelsByProvider: Record<SupportedProvider, string[]>;
      };
    };

    expect(snapshot.state?.selectedProvider).toBe('openrouter');
    expect(snapshot.state?.modelsByProvider.openrouter).toBe('gpt-4o-mini');
    expect(snapshot.state?.enabledModelsByProvider.openrouter).toEqual(
      expect.arrayContaining(PROVIDER_MODELS.openrouter as string[])
    );

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });
});
