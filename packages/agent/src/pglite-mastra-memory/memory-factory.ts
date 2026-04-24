import { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  type RuntimeAssistantMemorySettings,
} from '../memory-settings';
import type { AssistantRunEventSink } from '../run-events';
import { PgliteMemoryStore } from './memory-store';
import type { PgliteDatabase } from './types';
import { PgliteVectorStore } from './vector-store';

export interface PgliteMastraMemoryOptions {
  database: PgliteDatabase;
  embedder?: MastraEmbeddingModel<string> | string;
  eventSink?: AssistantRunEventSink;
  id?: string;
  memorySettings?: RuntimeAssistantMemorySettings;
  runId?: string;
  /** @deprecated Use memorySettings.semanticRecall.enabled. */
  semanticRecall?: boolean;
}

export interface PgliteMastraMemoryResult {
  memory: Memory;
  storage: MastraCompositeStore;
  store: PgliteMemoryStore;
  vector: PgliteVectorStore;
}

function buildObservationalMemoryOption(
  settings: RuntimeAssistantMemorySettings['observationalMemory']
) {
  if (!settings.enabled) {
    return false;
  }

  return {
    model: settings.modelTarget,
    scope: settings.scope,
    ...(settings.retrievalMode === 'messages' ? { retrieval: { scope: settings.scope } } : {}),
    ...(settings.retrievalMode === 'vector'
      ? { retrieval: { vector: true, scope: settings.scope } }
      : {}),
    observation: {
      messageTokens: settings.messageTokens,
    },
    reflection: {
      observationTokens: settings.observationTokens,
    },
  } as const;
}

function buildSemanticRecallOption(settings: RuntimeAssistantMemorySettings['semanticRecall']) {
  if (!settings.enabled) {
    return false;
  }

  return {
    topK: settings.topK,
    messageRange: settings.messageRange,
    scope: settings.scope,
  };
}

export async function createPgliteMastraMemory({
  database,
  embedder,
  eventSink,
  id = 'brainstrike-pglite-memory',
  memorySettings = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  runId,
  semanticRecall = false,
}: PgliteMastraMemoryOptions): Promise<PgliteMastraMemoryResult> {
  const semanticRecallEnabled = semanticRecall || memorySettings.semanticRecall.enabled;
  if (semanticRecallEnabled && !embedder) {
    throw new Error('PGlite Mastra semantic recall requires an explicit embedder.');
  }

  const store = new PgliteMemoryStore({
    database,
    ...(eventSink ? { eventSink } : {}),
    ...(runId ? { runId } : {}),
  });
  await store.init();
  const storage = new MastraCompositeStore({
    id: `${id}-storage`,
    domains: { memory: store },
  });
  const vector = new PgliteVectorStore({
    database,
    id: `${id}-vector`,
    ...(eventSink ? { eventSink } : {}),
    ...(runId ? { runId } : {}),
  });
  const memory = new Memory({
    storage,
    vector,
    ...(embedder ? { embedder } : {}),
    options: {
      lastMessages: 40,
      semanticRecall: semanticRecall
        ? true
        : buildSemanticRecallOption(memorySettings.semanticRecall),
      workingMemory: { enabled: true, scope: 'resource' },
      observationalMemory: buildObservationalMemoryOption(memorySettings.observationalMemory),
    },
  });

  return { memory, storage, store, vector };
}
