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
import { TursoMemoryStore } from './memory-store';
import type { TursoMastraSqlClient } from './types';
import { TursoWorkflowsStore } from './workflows-store';

type MastraRuntimeMemoryOptions = NonNullable<AgentMemoryOption['options']>;

export interface TursoMastraMemoryOptions {
  database: TursoMastraSqlClient;
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

export interface TursoMastraMemoryResult {
  memory: Memory;
  storage: MastraCompositeStore;
  store: TursoMemoryStore;
  workflows: TursoWorkflowsStore;
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
    // Hosted memory settings own provider-backed features; runtime options
    // control Mastra's local window/working-memory behavior for this store.
    semanticRecall: semanticRecall
      ? true
      : buildSemanticRecallOption(memorySettings.semanticRecall),
    workingMemory: memoryOptions?.workingMemory ?? DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
    observationalMemory: buildObservationalMemoryOption(
      memorySettings.observationalMemory,
      observationalMemoryModel
    ),
  };
}

export async function createTursoMastraMemory({
  database,
  embedder,
  eventSink,
  id = 'brainstrike-turso-memory',
  memoryOptions,
  memorySettings = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemoryModel,
  runId,
  semanticRecall = false,
}: TursoMastraMemoryOptions): Promise<TursoMastraMemoryResult> {
  const semanticRecallEnabled = semanticRecall || memorySettings.semanticRecall.enabled;
  if (semanticRecallEnabled) {
    throw new Error('Turso Mastra semantic recall requires Turso vector memory support.');
  }
  const observationalVectorRetrievalEnabled =
    memorySettings.observationalMemory.enabled &&
    memorySettings.observationalMemory.retrievalMode === 'vector';
  if (observationalVectorRetrievalEnabled) {
    throw new Error(
      'Turso Mastra observational vector retrieval requires Turso vector memory support.'
    );
  }

  const store = new TursoMemoryStore({
    database,
    ...(eventSink ? { eventSink } : {}),
    ...(runId ? { runId } : {}),
  });
  await store.init();
  const workflows = new TursoWorkflowsStore({ database });
  await workflows.init();
  const storage = new MastraCompositeStore({
    id: `${id}-storage`,
    domains: { memory: store, workflows },
  });
  const memory = new Memory({
    storage,
    ...(embedder ? { embedder } : {}),
    options: buildMastraMemoryOptions({
      memoryOptions,
      memorySettings,
      observationalMemoryModel,
      semanticRecall,
    }),
  });

  return { memory, storage, store, workflows };
}
