import {
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  type RuntimeAssistantMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import type { AgentMemoryOption } from '@mastra/core/agent';
import type { MastraModelConfig, OpenAICompatibleConfig } from '@mastra/core/llm';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import type { AssistantRunEventSink } from '../run-events';
import { type BackgroundTaskScope, PgliteBackgroundTasksStore } from './background-store';
import { PgliteMemoryStore } from './memory-store';
import type { PgliteDatabase } from './types';
import { PgliteVectorStore } from './vector-store';
import { PgliteWorkflowsStore } from './workflows-store';

type MastraRuntimeMemoryOptions = NonNullable<AgentMemoryOption['options']>;
type ConcreteLanguageModel = Exclude<MastraModelConfig, string | OpenAICompatibleConfig>;

/**
 * A conversation-scoped background domain always carries the host's task
 * deadline (`resolveChildTaskTimeoutMs`); an unscoped store carries neither.
 */
export type BackgroundTaskOwnership =
  | { backgroundTaskScope: BackgroundTaskScope; backgroundTaskTimeoutMs: number }
  | { backgroundTaskScope?: undefined; backgroundTaskTimeoutMs?: undefined };

export type PgliteMastraMemoryOptions = BackgroundTaskOwnership & {
  database: PgliteDatabase;
  embedder?: MastraEmbeddingModel<string> | string;
  eventSink?: AssistantRunEventSink;
  id?: string;
  memoryOptions?: MastraRuntimeMemoryOptions;
  memorySettings?: RuntimeAssistantMemorySettings;
  observationalMemoryModel?: ConcreteLanguageModel;
  runId?: string;
  /** @deprecated Use memorySettings.semanticRecall.enabled. */
  semanticRecall?: boolean;
};

export interface PgliteMastraMemoryResult {
  backgroundTaskScope?: BackgroundTaskScope;
  memory: Memory;
  storage: MastraCompositeStore;
  store: PgliteMemoryStore;
  vector: PgliteVectorStore;
  workflows: PgliteWorkflowsStore;
}

function buildObservationalMemoryOption(
  settings: RuntimeAssistantMemorySettings['observationalMemory'],
  model: ConcreteLanguageModel | undefined
) {
  if (!settings.enabled) {
    return false;
  }
  if (!model) {
    throw new Error('PGlite Mastra observational memory requires an explicit model.');
  }

  return {
    model,
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
  observationalMemoryModel: ConcreteLanguageModel | undefined;
  semanticRecall: boolean;
}): MastraRuntimeMemoryOptions {
  return {
    ...memoryOptions,
    // Mastra's canonical title path runs asynchronously from the first user
    // message using the active agent model. Keep an explicit caller override,
    // including `false`, but enable the feature for assistant threads by
    // default. This is independent of Observational Memory and its scope.
    generateTitle: memoryOptions?.generateTitle ?? true,
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
  backgroundTaskScope,
  backgroundTaskTimeoutMs,
  database,
  embedder,
  eventSink,
  id = 'brainstrike-pglite-memory',
  memoryOptions,
  // Construction-safe default: an absent settings object must never
  // manufacture an enabled observer (the UI default's 'auto' sentinel is
  // resolved upstream in app-shell; enabled OM here requires BOTH resolved
  // settings and an explicit model).
  memorySettings = CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
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
  if (memorySettings.observationalMemory.enabled && !observationalMemoryModel) {
    throw new Error('PGlite Mastra observational memory requires an explicit model.');
  }

  const store = new PgliteMemoryStore({
    ...(backgroundTaskScope ? { backgroundTaskScope } : {}),
    database,
    ...(eventSink ? { eventSink } : {}),
    ...(runId ? { runId } : {}),
  });
  await store.init();
  const workflows = new PgliteWorkflowsStore({ database });
  await workflows.init();
  const backgroundTasks = new PgliteBackgroundTasksStore(
    database,
    backgroundTaskScope,
    backgroundTaskTimeoutMs
  );
  await backgroundTasks.init();
  const storage = new MastraCompositeStore({
    domains: { backgroundTasks, memory: store, workflows },
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

  return {
    ...(backgroundTaskScope ? { backgroundTaskScope } : {}),
    memory,
    storage,
    store,
    vector,
    workflows,
  };
}
