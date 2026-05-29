export type RuntimeAssistantMemoryScope = 'resource' | 'thread';

export type RuntimeAssistantMemoryRetrievalMode = 'off' | 'messages' | 'vector';

export interface RuntimeAssistantObservationalMemorySettings {
  enabled: boolean;
  messageTokens: number;
  modelTarget: string;
  observationTokens: number;
  retrievalMode: RuntimeAssistantMemoryRetrievalMode;
  scope: RuntimeAssistantMemoryScope;
}

export interface RuntimeAssistantSemanticRecallSettings {
  embeddingModelTarget: string | null;
  enabled: boolean;
  messageRange: number;
  scope: RuntimeAssistantMemoryScope;
  topK: number;
}

export interface RuntimeAssistantMemorySettings {
  observationalMemory: RuntimeAssistantObservationalMemorySettings;
  semanticRecall: RuntimeAssistantSemanticRecallSettings;
}

export const DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS: RuntimeAssistantMemorySettings = {
  observationalMemory: {
    enabled: true,
    // Background observation/reflection runs frequently, so default to a
    // fast, low-cost model. Must be a currently-supported model ID (see
    // provider-registry.ts) — the previous default (gpt-5.2-chat-latest) was
    // dropped in the 2026 frontier refresh.
    modelTarget: 'openai/gpt-5.4-mini',
    scope: 'thread',
    messageTokens: 30_000,
    observationTokens: 40_000,
    retrievalMode: 'off',
  },
  semanticRecall: {
    enabled: false,
    embeddingModelTarget: 'openai/text-embedding-3-small',
    scope: 'resource',
    topK: 5,
    messageRange: 2,
  },
};
