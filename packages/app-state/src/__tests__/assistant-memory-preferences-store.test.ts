import { beforeEach, describe, expect, it } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import {
  __resetAssistantMemoryPreferencesStoreForTests,
  ASSISTANT_MEMORY_PREFERENCES_STORE_NAME,
  useAssistantMemoryPreferencesStore,
} from '../stores/assistant-memory-preferences-store';

type MemoryPersistApi = typeof useAssistantMemoryPreferencesStore & {
  persist?: {
    getOptions?: () => {
      name: string;
      storage?: {
        getItem: (name: string) => unknown;
        setItem: (name: string, value: unknown) => void;
      };
    };
    rehydrate?: () => Promise<void>;
  };
};

describe('assistant-memory-preferences-store', () => {
  beforeEach(() => {
    __resetAssistantMemoryPreferencesStoreForTests();
  });

  it('migrates a dropped observational memory model target to a supported one', async () => {
    const persistApi = (useAssistantMemoryPreferencesStore as MemoryPersistApi).persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const legacy: StorageValue<unknown> = {
      state: {
        observationalMemory: {
          enabled: true,
          messageTokens: 30_000,
          modelTarget: 'openai/gpt-5.2-chat-latest',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
      version: 1,
    };

    options.storage.setItem(options.name, legacy);
    await persistApi.rehydrate?.();

    const settings = useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings();
    expect(settings.observationalMemory.modelTarget).toBe('openai/gpt-5.4-mini');
    // Embedding target was not dropped, so it is preserved.
    expect(settings.semanticRecall.embeddingModelTarget).toBe('openai/text-embedding-3-small');
  });

  it('self-heals a stale model target persisted at the current version', async () => {
    const persistApi = (useAssistantMemoryPreferencesStore as MemoryPersistApi).persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    // Same version as STORE_VERSION, so zustand's `migrate` does NOT run. The
    // dropped target must still be remapped on hydration so the persisted state
    // and the settings UI never reference a removed model.
    const sameVersionStale: StorageValue<unknown> = {
      state: {
        observationalMemory: {
          enabled: true,
          messageTokens: 30_000,
          modelTarget: 'openai/gpt-5.2-chat-latest',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
      version: 2,
    };

    options.storage.setItem(options.name, sameVersionStale);
    await persistApi.rehydrate?.();

    // Read raw state (not getRuntimeMemorySettings) to prove the persisted value
    // itself was healed, not just normalized on read.
    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.modelTarget).toBe(
      'openai/gpt-5.4-mini'
    );
  });

  // BST-1697. Memory targets are provider-PREFIXED composite keys, so an
  // OpenRouter route carries its own vendor segment too
  // ('openrouter/stealth/ox-alpha', not 'stealth/ox-alpha'). Getting that shape
  // wrong is silent: the key simply never matches and observational memory
  // keeps running against a delisted route.
  it.each([
    ['openrouter/stealth/ox-alpha', 'openrouter/qwen/qwen3.8-flash'],
    ['openrouter/qwen/qwen3.8-max', 'openrouter/qwen/qwen3.8-max-0902'],
    ['openrouter/inclusionai/ling-3.0-flash:free', 'openrouter/nvidia/nemotron-3.5-lightning'],
    ['openrouter/kwaipilot/kat-coder-air-v2.5', 'openrouter/kwaipilot/kat-coder-pro-v2.5'],
  ])('remaps the delisted OpenRouter memory target %s', async (from, to) => {
    const persistApi = (useAssistantMemoryPreferencesStore as MemoryPersistApi).persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const stale: StorageValue<unknown> = {
      state: {
        observationalMemory: {
          enabled: true,
          messageTokens: 30_000,
          modelTarget: from,
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
      version: 2,
    };

    options.storage.setItem(options.name, stale);
    await persistApi.rehydrate?.();

    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.modelTarget).toBe(to);
  });

  it('enables observations by default with the auto observer target (BST-940) and disables semantic recall', () => {
    const state = useAssistantMemoryPreferencesStore.getState();

    expect(ASSISTANT_MEMORY_PREFERENCES_STORE_NAME).toBe('assistant-memory-preferences.v1');
    expect(state.observationalMemory).toEqual({
      enabled: true,
      messageTokens: 30_000,
      modelTarget: 'auto',
      observationTokens: 40_000,
      retrievalMode: 'off',
      scope: 'thread',
    });
    expect(state.semanticRecall).toEqual({
      embeddingModelTarget: 'openai/text-embedding-3-small',
      enabled: false,
      messageRange: 2,
      scope: 'resource',
      topK: 5,
    });
  });

  it('persists observational memory model and threshold settings', () => {
    const store = useAssistantMemoryPreferencesStore.getState();

    store.setObservationalMemoryModelTarget('anthropic/claude-haiku-4-5');
    store.setObservationalMemoryScope('resource');
    store.setObservationMessageTokens(16_500.8);
    store.setReflectionObservationTokens(25_250.2);
    store.setObservationalRetrievalMode('messages');

    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory).toEqual({
      enabled: true,
      messageTokens: 16_500,
      modelTarget: 'anthropic/claude-haiku-4-5',
      observationTokens: 25_250,
      retrievalMode: 'messages',
      scope: 'resource',
    });
  });

  it('clamps token thresholds and semantic recall result counts to safe Mastra values', () => {
    const store = useAssistantMemoryPreferencesStore.getState();

    store.setObservationMessageTokens(12);
    store.setReflectionObservationTokens(Number.NaN);
    store.setSemanticRecallTopK(1000);
    store.setSemanticRecallMessageRange(-10);

    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.messageTokens).toBe(
      1000
    );
    expect(
      useAssistantMemoryPreferencesStore.getState().observationalMemory.observationTokens
    ).toBe(1000);
    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.topK).toBe(50);
    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.messageRange).toBe(0);
  });

  it('returns the exact runtime memory settings passed to Mastra', () => {
    const store = useAssistantMemoryPreferencesStore.getState();

    store.setSemanticRecallEnabled(true);
    store.setSemanticRecallEmbeddingModelTarget('google/gemini-embedding-001');
    store.setSemanticRecallScope('thread');

    expect(useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings()).toEqual({
      observationalMemory: {
        enabled: true,
        messageTokens: 30_000,
        modelTarget: 'auto',
        observationTokens: 40_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: 'google/gemini-embedding-001',
        enabled: true,
        messageRange: 2,
        scope: 'thread',
        topK: 5,
      },
    });
  });
});
