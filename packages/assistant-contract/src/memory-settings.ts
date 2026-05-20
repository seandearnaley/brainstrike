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
    modelTarget: 'openai/gpt-5.2-chat-latest',
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
