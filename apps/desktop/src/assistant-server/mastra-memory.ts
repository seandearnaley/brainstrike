/**
 * Desktop Mastra memory construction (BST-975 slice 5).
 *
 * ORDER-SENSITIVE ATOM: each database owner's two cache Maps, DESKTOP_MEMORY_CACHE_LIMIT, their
 * insertion-order (FIFO) evictors, and resetDesktopMastraMemoryCacheForTests
 * moved here together — splitting the maps from the evictors or the reset
 * silently breaks eviction pairing and cross-test isolation (BST-975 seam map).
 */

import { createHash } from 'node:crypto';
import {
  type AssistantRunEvent,
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  createDelegatedConversationBinding,
  createEmbeddingProvider,
  createLanguageModelProvider,
  createLocalHostEmbeddingModel,
  type RuntimeAssistantMemorySettings,
  type RuntimeData,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { parseRuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import {
  type DesktopMemoryModelTargetDescriptor,
  type DesktopMemoryModelTargetResolution,
  type DesktopObservationalMemoryModelTarget,
  type DesktopSemanticRecallEmbeddingModelTarget,
  parseObservationalMemoryModelTarget,
  parseSemanticRecallEmbeddingModelTarget,
  type RuntimeMemoryOptions,
} from '@brainstrike/assistant-service/memory-model-targets';
import type { DesktopMemoryFeature } from '@brainstrike/assistant-service/types';
import { type DesktopDatabase, getDatabase } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { createDesktopDelegatedConversationHost } from './delegated-conversation-host';
import {
  registerDesktopDelegatedCancellation,
  registerDesktopDelegatedDecision,
} from './delegated-execution-controls';
import { registerDesktopDelegatedFollowup } from './delegated-followup-controls';
import { createDesktopDelegatedInputContext } from './delegated-input-context';
import { captureDelegatedWorkspaceStart } from './delegated-workspace-snapshot';
import { resolveProviderApiKey } from './provider-credentials';
import { createRunCriticalDatabase } from './run-critical-database';
import type { TurnBoundarySnapshotDeps } from './snapshot-turn-boundaries';

export type DesktopMastraMemoryResult =
  import('@brainstrike/assistant-service/stream-init').AgentStreamMemoryResult;
type DesktopMastraMemoryPromise = Promise<DesktopMastraMemoryResult>;

const DESKTOP_MEMORY_CACHE_LIMIT = 16;
// Fully resolved memory instances are keyed by provider/model plus hashed API
// keys. Pending keychain resolutions are keyed by unresolved descriptors so
// concurrent desktop requests dedupe before the concrete cache key exists.
// Each map is independently bounded to the same small desktop cache limit.
interface DesktopMastraMemoryCache {
  readonly memories: Map<string, DesktopMastraMemoryPromise>;
  readonly resolutions: Map<string, DesktopMastraMemoryPromise>;
}

// Reset/reinitialization replaces the database owner. Pending resolutions stay
// attached to that owner and cannot repopulate the replacement owner's cache.
let desktopMastraMemoryCaches = new WeakMap<DesktopDatabase, DesktopMastraMemoryCache>();

function getDesktopMastraMemoryCache(database: DesktopDatabase): DesktopMastraMemoryCache {
  const existing = desktopMastraMemoryCaches.get(database);
  if (existing) {
    return existing;
  }
  const cache: DesktopMastraMemoryCache = { memories: new Map(), resolutions: new Map() };
  desktopMastraMemoryCaches.set(database, cache);
  return cache;
}

interface DesktopMastraMemoryCacheState {
  readonly cachedPromise?: DesktopMastraMemoryPromise | undefined;
  readonly observationalMemoryResolution: DesktopMemoryModelTargetResolution<DesktopMemoryModelTargetDescriptor>;
  readonly semanticRecallEmbeddingResolution: DesktopMemoryModelTargetResolution<DesktopMemoryModelTargetDescriptor>;
}

export class DesktopMemoryCredentialMissingError extends Error {
  readonly feature: DesktopMemoryFeature;
  readonly provider: SupportedProvider;

  constructor(feature: DesktopMemoryFeature, target: DesktopMemoryModelTargetDescriptor) {
    const featureLabel =
      feature === 'observational_memory' ? 'Observational memory' : 'Semantic recall';
    super(
      `${featureLabel} requires an API key for "${target.provider}". Add the key in Settings, then retry.`
    );
    this.name = 'DesktopMemoryCredentialMissingError';
    this.feature = feature;
    this.provider = target.provider;
  }
}

/** Host services memory construction can use (injected from the server options). */
interface DesktopMemoryDependencies {
  readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  readonly snapshots?: TurnBoundarySnapshotDeps | undefined;
}

export async function getDesktopMastraMemory(
  memorySettings: RuntimeAssistantMemorySettings | undefined,
  runId?: string | undefined,
  eventSink?: ((event: AssistantRunEvent) => void) | undefined,
  runtimeData?: RuntimeData | undefined,
  memoryDependencies?: DesktopMemoryDependencies | undefined
): Promise<DesktopMastraMemoryResult> {
  const database = await getDatabase();
  const cache = getDesktopMastraMemoryCache(database);
  const memoryOptions = runtimeData?.memory?.memoryOptions;
  const cacheState = createDesktopMastraMemoryCacheState({
    cache,
    memoryOptions,
    memorySettings,
    runId,
  });
  if (cacheState.cachedPromise) {
    return cacheState.cachedPromise;
  }

  if (!(runId || eventSink) && needsAsyncDesktopMemoryResolution(cacheState)) {
    const resolutionKey = buildDesktopMastraMemoryResolutionKey({
      memoryOptions,
      memorySettings,
      observationalMemoryDescriptor: getDesktopMemoryModelTargetDescriptor(
        cacheState.observationalMemoryResolution
      ),
      semanticRecallEmbeddingDescriptor: getDesktopMemoryModelTargetDescriptor(
        cacheState.semanticRecallEmbeddingResolution
      ),
    });
    const pendingResolution = cache.resolutions.get(resolutionKey);
    if (pendingResolution) {
      return pendingResolution;
    }
    const pendingMemory = createDesktopMastraMemoryFromCacheState({
      cache,
      cacheState,
      database,
      eventSink,
      memoryDependencies,
      memoryOptions,
      memorySettings,
      runId,
      runtimeData,
    });
    evictOldestDesktopMastraMemoryResolutionPromise(cache);
    cache.resolutions.set(resolutionKey, pendingMemory);
    void pendingMemory.then(
      () => cleanupDesktopMastraMemoryResolutionPromise(cache, resolutionKey, pendingMemory),
      () => cleanupDesktopMastraMemoryResolutionPromise(cache, resolutionKey, pendingMemory)
    );
    return pendingMemory;
  }

  return createDesktopMastraMemoryFromCacheState({
    cache,
    cacheState,
    database,
    eventSink,
    memoryDependencies,
    memoryOptions,
    memorySettings,
    runId,
    runtimeData,
  });
}

function createDesktopMastraMemoryCacheState({
  cache,
  memoryOptions,
  memorySettings,
  runId,
}: {
  readonly cache: DesktopMastraMemoryCache;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runId: string | undefined;
}): DesktopMastraMemoryCacheState {
  const observationalMemoryDescriptor =
    resolveDesktopObservationalMemoryModelTargetDescriptor(memorySettings);
  const semanticRecallEmbeddingDescriptor =
    resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(memorySettings);
  const observationalMemoryResolution = resolveRuntimeMemoryModelTarget(
    observationalMemoryDescriptor
  );
  const semanticRecallEmbeddingResolution = resolveRuntimeMemoryModelTarget(
    semanticRecallEmbeddingDescriptor
  );
  if (
    runId ||
    observationalMemoryResolution.kind === 'needs_async_resolution' ||
    semanticRecallEmbeddingResolution.kind === 'needs_async_resolution'
  ) {
    return {
      observationalMemoryResolution,
      semanticRecallEmbeddingResolution,
    };
  }

  const cacheKey = buildDesktopMastraMemoryCacheKey({
    memoryOptions,
    memorySettings,
    observationalMemoryTarget: getResolvedDesktopMemoryModelTarget(observationalMemoryResolution),
    semanticRecallEmbeddingTarget: getResolvedDesktopMemoryModelTarget(
      semanticRecallEmbeddingResolution
    ),
  });
  return {
    cachedPromise: cache.memories.get(cacheKey),
    observationalMemoryResolution,
    semanticRecallEmbeddingResolution,
  };
}

function needsAsyncDesktopMemoryResolution(cacheState: DesktopMastraMemoryCacheState): boolean {
  return (
    cacheState.observationalMemoryResolution.kind === 'needs_async_resolution' ||
    cacheState.semanticRecallEmbeddingResolution.kind === 'needs_async_resolution'
  );
}

async function createDesktopMastraMemoryFromCacheState({
  cache,
  database,
  cacheState,
  eventSink,
  memoryDependencies,
  memoryOptions,
  memorySettings,
  runId,
  runtimeData,
}: {
  readonly cache: DesktopMastraMemoryCache;
  readonly database: DesktopDatabase;
  readonly cacheState: DesktopMastraMemoryCacheState;
  readonly eventSink: ((event: AssistantRunEvent) => void) | undefined;
  readonly memoryDependencies: DesktopMemoryDependencies | undefined;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
}): Promise<DesktopMastraMemoryResult> {
  const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
  const observationalMemoryTarget = await resolveDesktopMemoryModelTargetResolution(
    cacheState.observationalMemoryResolution,
    'observational_memory'
  );
  const semanticRecallEmbeddingTarget = await resolveDesktopMemoryModelTargetResolution(
    cacheState.semanticRecallEmbeddingResolution,
    'semantic_recall'
  );
  const { embedder, observationalMemoryModel } = createDesktopMastraMemoryProviderBindings({
    memoryDependencies,
    observationalMemoryTarget,
    runtimeData,
    semanticRecallEmbeddingTarget,
  });
  if (runId) {
    const runDatabase = createRunCriticalDatabase(database, { eventSink, runId });
    // Run-scoped memory instances intentionally bypass the shared cache so the
    // per-run event sink cannot leak observability events across concurrent runs.
    const memory = await createPgliteMastraMemory({
      ...(runtimeData?.memory
        ? {
            backgroundTaskScope: {
              resourceId: runtimeData.memory.resourceId,
              threadId: runtimeData.memory.threadId,
            },
          }
        : {}),
      database: runDatabase,
      ...(embedder ? { embedder } : {}),
      ...(eventSink ? { eventSink } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
      runId,
    });
    // Run-time host queries (scope, budget, claims, events) take the same
    // run-critical foreground lane as the memory above. On the owner handle they
    // bypassed the serial work scheduler and timed out behind a maintenance
    // statement (live run 22, 2026-09-15). Workspace snapshot capture below
    // keeps the owner handle.
    const host = createDesktopDelegatedConversationHost(
      runDatabase,
      runId,
      createDesktopDelegatedInputContext(runtimeData),
      async (threadId) =>
        captureDelegatedWorkspaceStart(
          database,
          threadId,
          runtimeData,
          memoryDependencies?.snapshots
        ),
      // Absent → defaults; malformed → throws before any child can be admitted.
      parseRuntimeSubagentSettings(runtimeData?.subagentSettings)
    );
    return {
      ...memory,
      conversationBinding: {
        ...createDelegatedConversationBinding(host.persist),
        bindRun: host.bindRun,
        budget: host.budget,
        claimToolAction: host.claimToolAction,
        continuation: host.continuation,
        finishToolActions: host.finishToolActions,
        prepareToolAction: host.prepareToolAction,
        readAnsweredToolActionLeaves: host.readAnsweredToolActionLeaves,
        recordLiveDecision: host.recordLiveDecision,
        recordPromptManifest: host.recordPromptManifest,
        recordToolActionAnswers: host.recordToolActionAnswers,
        recordWakeup: host.recordWakeup,
        registerCancellation: (control) => registerDesktopDelegatedCancellation(runId, control),
        registerDecisionControl: (control) => registerDesktopDelegatedDecision(runId, control),
        registerFollowup: (control) =>
          registerDesktopDelegatedFollowup(runId, (scope, threadId, input) =>
            host.sendFollowup(scope, threadId, input, control)
          ),
        releaseUnexecutedToolAction: host.releaseUnexecutedToolAction,
        resolveParkedInvocation: host.resolveParkedInvocation,
        resolveToolAction: host.resolveToolAction,
      },
    };
  }
  const cacheKey = buildDesktopMastraMemoryCacheKey({
    memoryOptions,
    memorySettings,
    observationalMemoryTarget,
    semanticRecallEmbeddingTarget,
  });
  const cachedPromise = cache.memories.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }
  const memoryPromise = createPgliteMastraMemory({
    database,
    ...(embedder ? { embedder } : {}),
    ...(memoryOptions ? { memoryOptions } : {}),
    ...(memorySettings ? { memorySettings } : {}),
    ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
  });
  evictOldestDesktopMastraMemoryPromise(cache);
  cache.memories.set(cacheKey, memoryPromise);
  memoryPromise.catch(() => {
    if (cache.memories.get(cacheKey) === memoryPromise) {
      cache.memories.delete(cacheKey);
    }
  });
  return memoryPromise;
}

function resolveDesktopObservationalMemoryModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  // Absent settings must never manufacture an enabled observer — the UI
  // default's 'auto' sentinel is resolved renderer-side; requests without
  // memory settings get the construction-safe (observation-off) defaults.
  const effectiveSettings = memorySettings ?? CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const observationalMemorySettings = effectiveSettings.observationalMemory;
  if (!observationalMemorySettings.enabled) {
    return;
  }

  return parseObservationalMemoryModelTarget(observationalMemorySettings.modelTarget);
}

function resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  const effectiveSettings = memorySettings ?? CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const semanticRecallSettings = effectiveSettings.semanticRecall;
  // Observational-memory vector retrieval embeds observations with the SAME
  // configured embedder, so it needs the target resolved even when the
  // semantic-recall toggle itself is off (createPgliteMastraMemory throws
  // without an embedder in that mode).
  const observationalVectorRetrieval =
    effectiveSettings.observationalMemory.enabled &&
    effectiveSettings.observationalMemory.retrievalMode === 'vector';
  if (!(semanticRecallSettings.enabled || observationalVectorRetrieval)) {
    return;
  }
  if (!semanticRecallSettings.embeddingModelTarget?.trim()) {
    throw new Error(
      semanticRecallSettings.enabled
        ? 'Semantic recall requires a configured embedding model target.'
        : 'Observational vector retrieval requires a configured semantic recall embedding model target.'
    );
  }

  return parseSemanticRecallEmbeddingModelTarget(semanticRecallSettings.embeddingModelTarget);
}

function getDesktopMemoryModelTargetDescriptor<T extends DesktopMemoryModelTargetDescriptor>(
  resolution: DesktopMemoryModelTargetResolution<T>
): DesktopMemoryModelTargetDescriptor | undefined {
  if (resolution.kind === 'disabled') {
    return;
  }
  const target = resolution.kind === 'resolved' ? resolution.target : resolution.descriptor;
  return {
    model: target.model,
    provider: target.provider,
  };
}

function getResolvedDesktopMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  resolution: DesktopMemoryModelTargetResolution<T>
): (T & { readonly apiKey: string; readonly cacheKey: string }) | undefined {
  if (resolution.kind === 'disabled') {
    return;
  }
  if (resolution.kind === 'resolved') {
    return resolution.target;
  }
  throw new Error(
    `Desktop memory target "${resolution.descriptor.provider}/${resolution.descriptor.model}" requires async resolution before cache lookup.`
  );
}

/**
 * The built-in local provider needs no API key: its memory models are proxied
 * to the hidden llm-host, so the cache key carries a fixed marker instead of
 * a key hash.
 */
function resolveLocalMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T
): T & { readonly apiKey: string; readonly cacheKey: string } {
  return {
    ...target,
    apiKey: '',
    cacheKey: `${target.provider}/${target.model}:local-llm-host`,
  };
}

async function resolveDesktopMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T,
  feature: DesktopMemoryFeature
): Promise<T & { readonly apiKey: string; readonly cacheKey: string }> {
  const { model, provider } = target;
  if (provider === 'local') {
    return resolveLocalMemoryModelTarget(target);
  }
  const apiKey = await resolveProviderApiKey(provider);
  if (!apiKey) {
    throw new DesktopMemoryCredentialMissingError(feature, target);
  }

  return {
    ...target,
    apiKey,
    cacheKey: `${provider}/${model}:${hashSecretForCacheKey(apiKey)}`,
  };
}

async function resolveDesktopMemoryModelTargetResolution<
  T extends DesktopMemoryModelTargetDescriptor,
>(
  resolution: DesktopMemoryModelTargetResolution<T>,
  feature: DesktopMemoryFeature
): Promise<(T & { readonly apiKey: string; readonly cacheKey: string }) | undefined> {
  if (resolution.kind === 'disabled') {
    return;
  }
  if (resolution.kind === 'resolved') {
    return resolution.target;
  }
  return resolveDesktopMemoryModelTarget(resolution.descriptor, feature);
}

function resolveRuntimeMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T | undefined
): DesktopMemoryModelTargetResolution<T> {
  if (!target) {
    return { kind: 'disabled' };
  }
  if (target.provider === 'local') {
    return {
      kind: 'resolved',
      target: resolveLocalMemoryModelTarget(target),
    };
  }
  // BST-1352 review: RuntimeData no longer carries the request's bearer key
  // (credentials travel only as the direct authInput parameter and never enter
  // RequestContext serialization), so the old same-provider request-key reuse
  // is structurally gone. Every hosted target resolves through the SAME
  // env/keychain chain the request used (`resolveProviderApiKey`), so the
  // resolved VALUE is identical; the memory cache absorbs the extra read.
  return {
    descriptor: target,
    kind: 'needs_async_resolution',
  };
}

/**
 * Build the semantic-recall embedder for a local target: queries are proxied
 * to the hidden embedding-host renderer, and dimensions resolve lazily from
 * the models catalog.
 */
function createLocalSemanticRecallEmbedder(
  modelId: string,
  memoryDependencies: DesktopMemoryDependencies | undefined
): ReturnType<typeof createEmbeddingProvider> {
  const embeddingHostManager = memoryDependencies?.embeddingHostManager;
  if (!embeddingHostManager) {
    throw new Error(
      'Local semantic recall requires the embedding host manager; the assistant server was started without one.'
    );
  }
  // Mastra ships an internal copy of the AI SDK v5 types, so the structurally
  // identical EmbeddingModelV2 needs the same cast provider-factory uses for
  // MastraModelConfig.
  return createLocalHostEmbeddingModel({
    client: embeddingHostManager,
    modelId,
    resolveDimensions: () => resolveLocalEmbeddingDimensions(modelId),
  }) as unknown as ReturnType<typeof createEmbeddingProvider>;
}

async function resolveLocalEmbeddingDimensions(modelId: string): Promise<number> {
  const database = await getDatabase();
  const result = await database.query(
    'SELECT capabilities FROM models WHERE id = $1 AND provider_id = $2 LIMIT 1',
    [modelId, 'local']
  );
  const row = (result.rows as Array<{ capabilities?: unknown }>)[0];
  if (!row) {
    throw new Error(`Local embedding model "${modelId}" is not in the model catalog.`);
  }
  const capabilities =
    typeof row.capabilities === 'string'
      ? (JSON.parse(row.capabilities) as { defaultDimension?: unknown })
      : (row.capabilities as { defaultDimension?: unknown } | null | undefined);
  const dimension = capabilities?.defaultDimension;
  if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(
      `Local embedding model "${modelId}" has no valid defaultDimension in the model catalog.`
    );
  }
  return dimension;
}

function createDesktopMastraMemoryProviderBindings({
  memoryDependencies,
  observationalMemoryTarget,
  runtimeData,
  semanticRecallEmbeddingTarget,
}: {
  readonly memoryDependencies: DesktopMemoryDependencies | undefined;
  readonly observationalMemoryTarget: DesktopObservationalMemoryModelTarget | undefined;
  readonly runtimeData: RuntimeData | undefined;
  readonly semanticRecallEmbeddingTarget: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}): {
  readonly embedder: ReturnType<typeof createEmbeddingProvider> | undefined;
  readonly observationalMemoryModel: ReturnType<typeof createLanguageModelProvider> | undefined;
} {
  if (observationalMemoryTarget?.provider === 'local' && !runtimeData?.localLlmHostClient) {
    // Without the injected client, createLanguageModelProvider would construct the
    // in-process browser backend, which cannot run in Electron main.
    throw new Error(
      'Local observational memory model requires the llm-host proxy client on the runtime.'
    );
  }
  const observationalMemoryModel = observationalMemoryTarget
    ? createLanguageModelProvider(
        observationalMemoryTarget.provider,
        observationalMemoryTarget.apiKey,
        observationalMemoryTarget.model,
        runtimeData
      )
    : undefined;
  let embedder: ReturnType<typeof createEmbeddingProvider> | undefined;
  if (semanticRecallEmbeddingTarget) {
    embedder =
      semanticRecallEmbeddingTarget.provider === 'local'
        ? createLocalSemanticRecallEmbedder(semanticRecallEmbeddingTarget.model, memoryDependencies)
        : createEmbeddingProvider(
            semanticRecallEmbeddingTarget.provider,
            semanticRecallEmbeddingTarget.apiKey,
            semanticRecallEmbeddingTarget.model
          );
  }
  return { embedder, observationalMemoryModel };
}

function buildDesktopMastraMemoryCacheKey({
  memoryOptions,
  memorySettings,
  observationalMemoryTarget,
  semanticRecallEmbeddingTarget,
}: {
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryTarget: DesktopObservationalMemoryModelTarget | undefined;
  readonly semanticRecallEmbeddingTarget: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}): string {
  return stableJsonStringify({
    memoryOptions: memoryOptions ?? null,
    memorySettings: memorySettings ?? null,
    observationalMemoryModel: observationalMemoryTarget?.cacheKey ?? null,
    semanticRecallEmbedder: semanticRecallEmbeddingTarget?.cacheKey ?? null,
  });
}

function buildDesktopMastraMemoryResolutionKey({
  memoryOptions,
  memorySettings,
  observationalMemoryDescriptor,
  semanticRecallEmbeddingDescriptor,
}: {
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
  readonly semanticRecallEmbeddingDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
}): string {
  return stableJsonStringify({
    memoryOptions: memoryOptions ?? null,
    memorySettings: memorySettings ?? null,
    observationalMemoryDescriptor: observationalMemoryDescriptor ?? null,
    semanticRecallEmbeddingDescriptor: semanticRecallEmbeddingDescriptor ?? null,
  });
}

function cleanupDesktopMastraMemoryResolutionPromise(
  cache: DesktopMastraMemoryCache,
  resolutionKey: string,
  pendingMemory: DesktopMastraMemoryPromise
): void {
  if (cache.resolutions.get(resolutionKey) === pendingMemory) {
    cache.resolutions.delete(resolutionKey);
  }
}

function evictOldestDesktopMastraMemoryPromise(cache: DesktopMastraMemoryCache): void {
  if (cache.memories.size < DESKTOP_MEMORY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = cache.memories.keys().next().value;
  if (typeof oldestKey === 'string') {
    cache.memories.delete(oldestKey);
  }
}

function evictOldestDesktopMastraMemoryResolutionPromise(cache: DesktopMastraMemoryCache): void {
  if (cache.resolutions.size < DESKTOP_MEMORY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = cache.resolutions.keys().next().value;
  if (typeof oldestKey === 'string') {
    cache.resolutions.delete(oldestKey);
  }
}

function hashSecretForCacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  // Relational operators are significantly faster than localeCompare for ASCII strings
  // which is exactly what object keys are in 99% of these payloads
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, sortJsonValue((value as Record<string, unknown>)[key])])
  );
}

export function resetDesktopMastraMemoryCacheForTests(): void {
  desktopMastraMemoryCaches = new WeakMap();
}

export async function getDesktopMastraMemoryForTests(
  memorySettings: RuntimeAssistantMemorySettings | undefined,
  runtimeData?: RuntimeData | undefined,
  memoryDependencies?: DesktopMemoryDependencies
): Promise<DesktopMastraMemoryResult> {
  return getDesktopMastraMemory(
    memorySettings,
    undefined,
    undefined,
    runtimeData,
    memoryDependencies
  );
}
