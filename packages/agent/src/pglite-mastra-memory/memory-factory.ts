import {
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  type RuntimeAssistantMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import type { AgentMemoryOption } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import type { AssistantRunEventSink } from '../run-events';
import { PgliteMemoryStore } from './memory-store';
import type { PgliteDatabase } from './types';
import { PgliteVectorStore } from './vector-store';
import { PgliteWorkflowsStore } from './workflows-store';

type MastraRuntimeMemoryOptions = NonNullable<AgentMemoryOption['options']>;

export interface PgliteMastraMemoryOptions {
  database: PgliteDatabase;
  embedder?: MastraEmbeddingModel<string> | string;
  eventSink?: AssistantRunEventSink;
  id?: string;
  memoryOptions?: MastraRuntimeMemoryOptions;
  memorySettings?: RuntimeAssistantMemorySettings;
  observationalMemoryModel?: MastraModelConfig;
  runId?: string;
  /** @deprecated Use memorySettings.semanticRecall.enabled. */
  semanticRecall?: boolean;
}

export interface PgliteMastraMemoryResult {
  memory: Memory;
  storage: MastraCompositeStore;
  store: PgliteMemoryStore;
  vector: PgliteVectorStore;
  workflows: PgliteWorkflowsStore;
}

function buildObservationalMemoryOption(
  settings: RuntimeAssistantMemorySettings['observationalMemory'],
  model?: MastraModelConfig
) {
  if (!settings.enabled) {
    return false;
  }

  return {
    model: model ?? settings.modelTarget,
    scope: settings.scope,
    ...(settings.retrievalMode === 'messages' ? { retrieval: { scope: settings.scope } } : {}),
    ...(settings.retrievalMode === 'vector'
      ? { retrieval: { scope: settings.scope, vector: true } }
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
    messageRange: settings.messageRange,
    scope: settings.scope,
    topK: settings.topK,
  };
}

function buildMastraMemoryOptions({
  memoryOptions,
  memorySettings,
  observationalMemoryModel,
  semanticRecall,
}: {
  memoryOptions: MastraRuntimeMemoryOptions | undefined;
  memorySettings: RuntimeAssistantMemorySettings;
  observationalMemoryModel: MastraModelConfig | undefined;
  semanticRecall: boolean;
}): MastraRuntimeMemoryOptions {
  return {
    ...memoryOptions,
    lastMessages: memoryOptions?.lastMessages ?? DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
    observationalMemory: buildObservationalMemoryOption(
      memorySettings.observationalMemory,
      observationalMemoryModel
    ),
    // Hosted memory settings own provider-backed features; runtime options
    // control Mastra's local window/working-memory behavior for this store.
    semanticRecall: semanticRecall
      ? true
      : buildSemanticRecallOption(memorySettings.semanticRecall),
    workingMemory: memoryOptions?.workingMemory ?? DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  };
}

export async function createPgliteMastraMemory({
  database,
  embedder,
  eventSink,
  id = 'brainstrike-pglite-memory',
  memoryOptions,
  memorySettings = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemoryModel,
  runId,
  semanticRecall = false,
}: PgliteMastraMemoryOptions): Promise<PgliteMastraMemoryResult> {
  const semanticRecallEnabled = semanticRecall || memorySettings.semanticRecall.enabled;
  if (semanticRecallEnabled && !embedder) {
    throw new Error('PGlite Mastra semantic recall requires an explicit embedder.');
  }
  const observationalVectorRetrievalEnabled =
    memorySettings.observationalMemory.enabled &&
    memorySettings.observationalMemory.retrievalMode === 'vector';
  if (observationalVectorRetrievalEnabled && !embedder) {
    throw new Error('PGlite Mastra observational vector retrieval requires an explicit embedder.');
  }

  const store = new PgliteMemoryStore({
    database,
    ...(eventSink ? { eventSink } : {}),
    ...(runId ? { runId } : {}),
  });
  await store.init();
  const workflows = new PgliteWorkflowsStore({ database });
  await workflows.init();
  const storage = new MastraCompositeStore({
    domains: { memory: store, workflows },
    id: `${id}-storage`,
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
    options: buildMastraMemoryOptions({
      memoryOptions,
      memorySettings,
      observationalMemoryModel,
      semanticRecall,
    }),
  });

  return { memory, storage, store, vector, workflows };
}
