import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAssistantMemoryPreferencesStoreForTests,
  ASSISTANT_MEMORY_PREFERENCES_STORE_NAME,
  useAssistantMemoryPreferencesStore,
} from '../stores/assistant-memory-preferences-store';

describe('assistant-memory-preferences-store', () => {
  beforeEach(() => {
    __resetAssistantMemoryPreferencesStoreForTests();
  });

  it('uses explicit defaults for Mastra observational memory and disables semantic recall', () => {
    const state = useAssistantMemoryPreferencesStore.getState();

    expect(ASSISTANT_MEMORY_PREFERENCES_STORE_NAME).toBe('assistant-memory-preferences.v1');
    expect(state.observationalMemory).toEqual({
      enabled: true,
      modelTarget: 'openai/gpt-5.2-chat-latest',
      scope: 'thread',
      messageTokens: 30_000,
      observationTokens: 40_000,
      retrievalMode: 'off',
    });
    expect(state.semanticRecall).toEqual({
      enabled: false,
      embeddingModelTarget: 'openai/text-embedding-3-small',
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
      modelTarget: 'anthropic/claude-haiku-4-5',
      scope: 'resource',
      messageTokens: 16_500,
      observationTokens: 25_250,
      retrievalMode: 'messages',
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
        modelTarget: 'openai/gpt-5.2-chat-latest',
        scope: 'thread',
        messageTokens: 30_000,
        observationTokens: 40_000,
        retrievalMode: 'off',
      },
      semanticRecall: {
        enabled: true,
        embeddingModelTarget: 'google/gemini-embedding-001',
        messageRange: 2,
        scope: 'thread',
        topK: 5,
      },
    });
  });
});
