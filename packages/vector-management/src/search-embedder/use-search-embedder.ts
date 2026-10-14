/**
 * useSearchEmbedder Hook
 *
 * Shared embedder-resolution machinery for semantic search surfaces. Owns the
 * cached hosted/local `SearchEmbedder`, the promise-dedup initialization gate,
 * WebGPU device-loss detection + single-retry recovery, and the
 * visibilitychange dispose for WebGPU-backed embedders.
 *
 * The model-info resolution (a DB query for the active embedding set) stays
 * with callers; this hook takes an already-resolved `EmbeddingSetModelInfo`.
 */

import { useVectorPreferencesStore } from '@brainstrike/app-state/stores/vector-preferences-store';
import type { EmbeddingExecutionOptions, EmbeddingProviderConfig } from '@brainstrike/embeddings';
import {
  isHostedProvider,
  type EmbeddingModelConfig as ModelConfig,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useRef } from 'react';

const logger = createLogger('SearchEmbedder');

// `runtime` lets the visibility-change handler avoid disposing embedders
// that can't suffer GPUDevice loss (hosted providers have no local model,
// wasm runs on CPU). Re-initializing a 300MB WASM model on every
// background/foreground cycle would be a real perf regression.
export type EmbedderRuntime = 'webgpu' | 'wasm' | 'hosted';
type LocalEmbedderRuntime = Exclude<EmbedderRuntime, 'hosted'>;

export interface SearchEmbedder {
  dispose?: () => Promise<void> | void;
  embedDocument: (text: string) => Promise<{ embedding: number[] }>;
  embedQuery: (
    text: string,
    options?: EmbeddingExecutionOptions
  ) => Promise<{ embedding: number[] }>;
  runtime: EmbedderRuntime;
}

export type LocalSearchEmbedderFactory = (
  modelConfig: ModelConfig,
  device: LocalEmbedderRuntime
) => Promise<SearchEmbedder>;

type EmbedderError =
  | { message: string }
  | { originalError: { message: string }; type: string }
  | { type: string };

/**
 * Resolved model info for the active embedding set. The DB query that produces
 * this stays with callers; the hook consumes the resolved shape.
 */
export interface EmbeddingSetModelInfo {
  dimensions: number;
  /** Resolved local config, null for hosted providers. */
  modelConfig: ModelConfig | null;
  modelKey: string;
}

export interface UseSearchEmbedderResult {
  /** Embed indexed content with document semantics and device-loss recovery. */
  embedDocumentWithRecovery: (info: EmbeddingSetModelInfo, text: string) => Promise<number[]>;
  /** Embed with the device-loss single-retry semantics from db-explorer. */
  embedQueryWithRecovery: (
    info: EmbeddingSetModelInfo,
    text: string,
    options?: EmbeddingExecutionOptions
  ) => Promise<number[]>;
  /** Resolves (cached) embedder for the model; throws with named causes (no key, no local model, …). */
  ensureEmbedderReady: (info: EmbeddingSetModelInfo) => Promise<SearchEmbedder>;
}

interface EmbedderIdentity {
  cacheKey: string;
  modelKey: string;
  runtime: EmbedderRuntime;
}

interface EmbedderInitialization {
  identity: EmbedderIdentity;
  invalidatedBy: string | null;
  promise: Promise<SearchEmbedder>;
}

interface EmbedderRecovery {
  identity: EmbedderIdentity;
  promise: Promise<SearchEmbedder>;
}

type LifecycleInvalidationReason = 'document-hidden' | 'unmount';

interface LifecycleState {
  generation: number;
  reason: LifecycleInvalidationReason | null;
}

/**
 * Create a hosted provider embedder
 */
async function createHostedEmbedder(
  queryProviderConfig: EmbeddingProviderConfig,
  documentProviderConfig: EmbeddingProviderConfig,
  modelId: string
): Promise<SearchEmbedder> {
  const { EmbeddingProviderFactory } = await import('@brainstrike/embeddings/factory');
  const queryProviderResult = await EmbeddingProviderFactory.createProvider(queryProviderConfig);
  logger.info('Hosted query provider creation result', { ok: queryProviderResult.ok });

  if (!queryProviderResult.ok) {
    throw new Error(
      `Failed to initialize hosted query provider: ${
        'message' in queryProviderResult.error
          ? queryProviderResult.error.message
          : queryProviderResult.error.type
      }`
    );
  }

  const needsDistinctDocumentProvider =
    queryProviderConfig.provider === 'cohere' || queryProviderConfig.provider === 'voyage';
  const documentProviderResult = needsDistinctDocumentProvider
    ? await EmbeddingProviderFactory.createProvider(documentProviderConfig)
    : queryProviderResult;
  logger.info('Hosted document provider creation result', { ok: documentProviderResult.ok });

  if (!documentProviderResult.ok) {
    throw new Error(
      `Failed to initialize hosted document provider: ${
        'message' in documentProviderResult.error
          ? documentProviderResult.error.message
          : documentProviderResult.error.type
      }`
    );
  }

  const queryProvider = queryProviderResult.value;
  const documentProvider = documentProviderResult.value;

  const embed = async (
    provider: typeof queryProvider,
    text: string,
    options?: EmbeddingExecutionOptions
  ): Promise<{ embedding: number[] }> => {
    options?.signal?.throwIfAborted();
    const result = await provider.embed({
      modelId,
      ...(options?.signal ? { signal: options.signal } : {}),
      text,
    });
    options?.signal?.throwIfAborted();
    if (!result.ok) {
      const error: EmbedderError = result.error;
      if ('originalError' in error && isAbortError(error.originalError)) {
        throw error.originalError;
      }
      const msg =
        'message' in error
          ? error.message
          : 'originalError' in error
            ? error.originalError.message
            : error.type;
      throw new Error(`Embedding failed: ${msg}`);
    }
    return { embedding: result.value.embedding };
  };

  return {
    embedDocument: (text: string) => embed(documentProvider, text),
    embedQuery: (text: string, options?: EmbeddingExecutionOptions) =>
      embed(queryProvider, text, options),
    runtime: 'hosted',
  };
}

/**
 * Create a local provider embedder
 */
async function createLocalEmbedder(
  modelConfig: ModelConfig,
  devicePreference: LocalEmbedderRuntime
): Promise<SearchEmbedder> {
  logger.info('Creating local embedder (SimpleEmbeddingService)', { modelKey: modelConfig.id });
  const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
  const svc = new SimpleEmbeddingService();
  logger.info('Initializing local model...');
  try {
    await svc.initializeWithModel(modelConfig, undefined, devicePreference);
  } catch (initializationError: unknown) {
    try {
      await Promise.resolve(svc.dispose());
    } catch (disposalError: unknown) {
      throw new AggregateError(
        [initializationError, disposalError],
        `Failed to initialize local embedder ${modelConfig.id}; disposing the partial service also failed`
      );
    }
    throw initializationError;
  }
  logger.info('Local model initialized');

  return {
    dispose: () => svc.dispose(),
    embedDocument: async (text: string) => {
      logger.info('Generating document embedding with local model...');
      const result = await svc.generateDocEmbedding(text);
      return { embedding: Array.from(result.embedding) };
    },
    embedQuery: async (text: string, options?: EmbeddingExecutionOptions) => {
      logger.info('Generating query embedding with local model...');
      options?.signal?.throwIfAborted();
      const result = options
        ? await svc.generateQueryEmbedding(text, options)
        : await svc.generateQueryEmbedding(text);
      options?.signal?.throwIfAborted();
      return { embedding: Array.from(result.embedding) };
    },
    runtime: devicePreference,
  };
}

// WebGPU device-loss recovery (visible-renderer only): we cannot disable
// Chromium background throttling on the visible window (per docs/agents/local-inference.md), so
// a cached embedder's GPU device can be invalidated after backgrounding.
// Pattern-match the error text instead of relying on a typed exception
// because the loss surfaces through transformers.js / ONNX Runtime Web as
// a plain Error with one of these message fragments.
const DEVICE_LOSS_ERROR_FRAGMENTS = [
  'webgpu device was lost',
  'device.destroyed',
  'device was lost',
  'gpudevice is lost',
  'gpudevice was destroyed',
];

function isDeviceLossError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lower = error.message.toLowerCase();
  return DEVICE_LOSS_ERROR_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Create hosted provider config
 */
function createHostedConfig(
  provider: string,
  modelId: string,
  dimensions: number,
  purpose: 'document' | 'query'
): EmbeddingProviderConfig {
  if (provider === 'openai') {
    return { dimensions, modelId, provider: 'openai', runtime: 'hosted' };
  }
  if (provider === 'google') {
    return {
      modelId,
      outputDimensionality: dimensions,
      provider: 'google',
      runtime: 'hosted',
    };
  }
  if (provider === 'cohere') {
    return {
      inputType: purpose === 'query' ? 'search_query' : 'search_document',
      modelId,
      provider: 'cohere',
      runtime: 'hosted',
    };
  }
  if (provider === 'voyage') {
    return { inputType: purpose, modelId, provider: 'voyage', runtime: 'hosted' };
  }
  throw new Error(`Unsupported hosted provider: ${provider}`);
}

function createLocalConfigCacheKey(modelConfig: ModelConfig | null): unknown {
  if (!modelConfig) {
    return null;
  }
  return [modelConfig.dimensions, modelConfig.id, Boolean(modelConfig.quantized)];
}

function createEmbedderIdentity(
  { dimensions, modelConfig, modelKey }: EmbeddingSetModelInfo,
  devicePref: LocalEmbedderRuntime
): EmbedderIdentity {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  if (parsed && isHostedProvider(parsed.provider)) {
    return {
      cacheKey: JSON.stringify(['hosted', modelKey, dimensions]),
      modelKey,
      runtime: 'hosted',
    };
  }
  return {
    cacheKey: JSON.stringify([
      'local',
      modelKey,
      dimensions,
      devicePref,
      createLocalConfigCacheKey(modelConfig),
    ]),
    modelKey,
    runtime: devicePref,
  };
}

async function createSearchEmbedder(
  { modelKey, dimensions, modelConfig }: EmbeddingSetModelInfo,
  devicePref: LocalEmbedderRuntime,
  createLocal: LocalSearchEmbedderFactory
): Promise<SearchEmbedder> {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  const isHosted = parsed ? isHostedProvider(parsed.provider) : false;
  logger.info('Provider detection', { isHosted });

  if (parsed && isHostedProvider(parsed.provider)) {
    logger.info('Creating hosted provider', { provider: parsed.provider });
    const queryProviderConfig = createHostedConfig(
      parsed.provider,
      parsed.modelId,
      dimensions,
      'query'
    );
    const documentProviderConfig = createHostedConfig(
      parsed.provider,
      parsed.modelId,
      dimensions,
      'document'
    );
    return createHostedEmbedder(queryProviderConfig, documentProviderConfig, parsed.modelId);
  }

  if (!modelConfig) {
    throw new Error('No local embedding model configured. Enable one in Settings > Models.');
  }
  return createLocal(modelConfig, devicePref);
}

function invalidatedInitializationMessage(initialization: EmbedderInitialization): string {
  return `Embedding initialization for ${initialization.identity.modelKey} was ${initialization.invalidatedBy ?? 'invalidated by a newer request'}`;
}

async function rejectInvalidatedInitialization(
  embedder: SearchEmbedder,
  initialization: EmbedderInitialization
): Promise<never> {
  const message = invalidatedInitializationMessage(initialization);
  if (!embedder.dispose) {
    throw new Error(message);
  }

  try {
    await Promise.resolve(embedder.dispose());
  } catch (error: unknown) {
    throw new Error(
      `${message}; failed to dispose the stale embedder: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  throw new Error(message);
}

async function embedText(
  embedder: SearchEmbedder,
  text: string,
  purpose: 'document' | 'query',
  options?: EmbeddingExecutionOptions
): Promise<number[]> {
  const { embedding } =
    purpose === 'query'
      ? await embedder.embedQuery(text, options)
      : await embedder.embedDocument(text);
  return embedding;
}

function recoverySupersededError(requested: EmbedderIdentity, active: EmbedderIdentity): Error {
  return new Error(
    `Device-loss recovery for ${requested.modelKey} was superseded by ${active.modelKey} (request ${requested.cacheKey}; active ${active.cacheKey})`
  );
}

function recoveryInvalidatedError(requested: EmbedderIdentity, reason: string): Error {
  return new Error(`Device-loss recovery for ${requested.modelKey} was invalidated by ${reason}`);
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function assertWebGpuInitializationVisible(identity: EmbedderIdentity): void {
  if (identity.runtime !== 'webgpu' || !isDocumentHidden()) {
    return;
  }
  throw new Error(
    `Embedding initialization for ${identity.modelKey} was invalidated by document-hidden`
  );
}

async function resolveRecoveryEmbedder({
  activeEmbedder,
  activeIdentity,
  activeInitialization,
  failedWasCurrent,
  requestedIdentity,
  startReplacement,
}: {
  activeEmbedder: SearchEmbedder | null;
  activeIdentity: EmbedderIdentity | null;
  activeInitialization: EmbedderInitialization | null;
  failedWasCurrent: boolean;
  requestedIdentity: EmbedderIdentity;
  startReplacement: () => Promise<SearchEmbedder>;
}): Promise<SearchEmbedder> {
  if (Boolean(activeEmbedder) !== Boolean(activeIdentity)) {
    throw new Error('Search embedder cache identity invariant violated during device recovery');
  }
  if (activeEmbedder && activeIdentity) {
    if (activeIdentity.cacheKey !== requestedIdentity.cacheKey) {
      throw recoverySupersededError(requestedIdentity, activeIdentity);
    }
    return activeEmbedder;
  }
  if (activeInitialization) {
    if (activeInitialization.identity.cacheKey !== requestedIdentity.cacheKey) {
      throw recoverySupersededError(requestedIdentity, activeInitialization.identity);
    }
    return activeInitialization.promise;
  }
  if (!failedWasCurrent) {
    throw new Error(
      `Device-loss recovery for ${requestedIdentity.modelKey} was invalidated before replacement`
    );
  }
  return startReplacement();
}

/**
 * Shared embedder resolution + device-loss recovery for semantic search.
 */
export function useSearchEmbedder(
  createLocal: LocalSearchEmbedderFactory = createLocalEmbedder
): UseSearchEmbedderResult {
  const devicePref = useVectorPreferencesStore((state) => state.devicePref);
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentIdentityRef = useRef<EmbedderIdentity | null>(null);
  const initializationRef = useRef<EmbedderInitialization | null>(null);
  const lifecycleStateRef = useRef<LifecycleState>({ generation: 0, reason: null });
  const transitionGateRef = useRef<Promise<unknown> | null>(null);
  const recoveryByEmbedderRef = useRef<WeakMap<SearchEmbedder, EmbedderRecovery> | null>(null);
  if (!recoveryByEmbedderRef.current) {
    recoveryByEmbedderRef.current = new WeakMap();
  }

  const disposeCachedEmbedder = useCallback(
    async (reason: string, expected?: SearchEmbedder): Promise<boolean> => {
      const embedder = embedderRef.current;
      if (!embedder || (expected && embedder !== expected)) {
        return false;
      }
      embedderRef.current = null;
      currentIdentityRef.current = null;
      if (!embedder.dispose) {
        return true;
      }

      const invokeDisposal = (): Promise<void> => {
        try {
          return Promise.resolve(embedder.dispose?.());
        } catch (error: unknown) {
          return Promise.reject(error);
        }
      };
      const priorTransition = transitionGateRef.current;
      const disposal = priorTransition
        ? priorTransition.then(invokeDisposal, invokeDisposal)
        : invokeDisposal();
      transitionGateRef.current = disposal;
      try {
        await disposal;
        logger.debug('Disposed cached embedder', { reason });
      } catch (error: unknown) {
        logger.error('Failed to dispose embedder', {
          error: error instanceof Error ? error.message : String(error),
          reason,
        });
      } finally {
        if (transitionGateRef.current === disposal) {
          transitionGateRef.current = null;
        }
      }
      return true;
    },
    []
  );

  const invalidateLifecycle = useCallback((reason: LifecycleInvalidationReason): void => {
    lifecycleStateRef.current = {
      generation: lifecycleStateRef.current.generation + 1,
      reason,
    };
  }, []);

  const invalidateInitialization = useCallback(
    (reason: string, runtime?: EmbedderRuntime): boolean => {
      const initialization = initializationRef.current;
      if (!initialization || (runtime && initialization.identity.runtime !== runtime)) {
        return false;
      }
      initialization.invalidatedBy = `invalidated by ${reason}`;
      initializationRef.current = null;
      return true;
    },
    []
  );

  useEffect(
    () => () => {
      invalidateLifecycle('unmount');
      invalidateInitialization('unmount');
      void disposeCachedEmbedder('unmount');
    },
    [disposeCachedEmbedder, invalidateInitialization, invalidateLifecycle]
  );

  // Visible-renderer can't disable Chromium throttling — when the document
  // is hidden the renderer may be frozen and the WebGPU device invalidated.
  // Dispose proactively so the next user-triggered search rebuilds a fresh
  // embedder rather than crashing on a stale GPUDevice.
  //
  // Gated to WebGPU-backed embedders: WASM has no GPUDevice and hosted
  // providers hold only API client state, so disposing them on every
  // background/foreground cycle is avoidable model-reload thrash.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const onVisibilityChange = (): void => {
      if (!document.hidden) {
        return;
      }
      invalidateLifecycle('document-hidden');
      const hasCachedWebGpu = embedderRef.current?.runtime === 'webgpu';
      const hasInitializingWebGpu = initializationRef.current?.identity.runtime === 'webgpu';
      if (!(hasCachedWebGpu || hasInitializingWebGpu)) {
        return;
      }
      if (hasInitializingWebGpu) {
        invalidateInitialization('document-hidden', 'webgpu');
      }
      if (hasCachedWebGpu) {
        void disposeCachedEmbedder('document-hidden');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [disposeCachedEmbedder, invalidateInitialization, invalidateLifecycle]);

  /**
   * Ensure embedder is ready for the given model.
   * Uses promise caching to prevent race conditions when multiple concurrent
   * calls attempt to initialize the embedder simultaneously.
   */
  const ensureEmbedderReady = useCallback(
    async ({
      modelKey,
      dimensions,
      modelConfig,
    }: EmbeddingSetModelInfo): Promise<SearchEmbedder> => {
      logger.info('ensureEmbedderReady called', { dimensions, modelKey });
      const info = { dimensions, modelConfig, modelKey };
      const identity = createEmbedderIdentity(info, devicePref);
      assertWebGpuInitializationVisible(identity);

      if (embedderRef.current && currentIdentityRef.current?.cacheKey === identity.cacheKey) {
        logger.info('Reusing cached embedder');
        return embedderRef.current;
      }

      const inFlight = initializationRef.current;
      if (inFlight?.identity.cacheKey === identity.cacheKey) {
        logger.info('Waiting for in-flight embedder initialization');
        return inFlight.promise;
      }

      if (inFlight) {
        inFlight.invalidatedBy = `superseded by ${identity.modelKey} (request ${identity.cacheKey})`;
      }

      const previousEmbedder = embedderRef.current;
      embedderRef.current = null;
      currentIdentityRef.current = null;
      const priorTransition = transitionGateRef.current;
      const transitionStart = priorTransition
        ? priorTransition.then(
            () => undefined,
            () => undefined
          )
        : Promise.resolve();

      let initialization!: EmbedderInitialization;
      let initPromise!: Promise<SearchEmbedder>;
      const clearFailedInitialization = (): void => {
        if (initializationRef.current !== initialization) {
          return;
        }
        embedderRef.current = null;
        currentIdentityRef.current = null;
      };
      const finishInitialization = (): void => {
        if (initializationRef.current === initialization) {
          initializationRef.current = null;
        }
        if (transitionGateRef.current === initPromise) {
          transitionGateRef.current = null;
        }
      };
      initPromise = transitionStart.then(async (): Promise<SearchEmbedder> => {
        try {
          if (previousEmbedder?.dispose) {
            logger.info('Disposing previous embedder');
            await previousEmbedder.dispose();
          }

          if (initializationRef.current !== initialization) {
            throw new Error(invalidatedInitializationMessage(initialization));
          }
          assertWebGpuInitializationVisible(identity);

          const embedder = await createSearchEmbedder(info, devicePref, createLocal);

          if (initializationRef.current !== initialization) {
            return rejectInvalidatedInitialization(embedder, initialization);
          }

          embedderRef.current = embedder;
          currentIdentityRef.current = identity;
          return embedder;
        } catch (error) {
          clearFailedInitialization();
          throw error;
        } finally {
          finishInitialization();
        }
      });

      initialization = { identity, invalidatedBy: null, promise: initPromise };
      initializationRef.current = initialization;
      transitionGateRef.current = initPromise;
      return initPromise;
    },
    [createLocal, devicePref]
  );

  const recoverEmbedderAfterDeviceLoss = useCallback(
    (failedEmbedder: SearchEmbedder, info: EmbeddingSetModelInfo): Promise<SearchEmbedder> => {
      const requestedIdentity = createEmbedderIdentity(info, devicePref);
      const lifecycleGeneration = lifecycleStateRef.current.generation;
      const recoveryByEmbedder = recoveryByEmbedderRef.current;
      if (!recoveryByEmbedder) {
        return Promise.reject(new Error('Search embedder recovery registry is unavailable'));
      }

      const existing = recoveryByEmbedder.get(failedEmbedder);
      if (existing) {
        if (existing.identity.cacheKey !== requestedIdentity.cacheKey) {
          return Promise.reject(recoverySupersededError(requestedIdentity, existing.identity));
        }
        return existing.promise;
      }

      let recovery!: EmbedderRecovery;
      const promise = Promise.resolve()
        .then(async () => {
          if (lifecycleStateRef.current.generation !== lifecycleGeneration) {
            throw recoveryInvalidatedError(
              requestedIdentity,
              lifecycleStateRef.current.reason ?? 'lifecycle-change'
            );
          }
          const failedWasCurrent = await disposeCachedEmbedder('device-loss', failedEmbedder);
          if (lifecycleStateRef.current.generation !== lifecycleGeneration) {
            throw recoveryInvalidatedError(
              requestedIdentity,
              lifecycleStateRef.current.reason ?? 'lifecycle-change'
            );
          }
          return resolveRecoveryEmbedder({
            activeEmbedder: embedderRef.current,
            activeIdentity: currentIdentityRef.current,
            activeInitialization: initializationRef.current,
            failedWasCurrent,
            requestedIdentity,
            startReplacement: () => ensureEmbedderReady(info),
          });
        })
        .finally(() => {
          if (recoveryByEmbedder.get(failedEmbedder) === recovery) {
            recoveryByEmbedder.delete(failedEmbedder);
          }
        });
      recovery = { identity: requestedIdentity, promise };
      recoveryByEmbedder.set(failedEmbedder, recovery);
      return promise;
    },
    [devicePref, disposeCachedEmbedder, ensureEmbedderReady]
  );

  /**
   * Generate an embedding. If the cached embedder's GPUDevice was
   * invalidated (e.g. visible renderer was backgrounded then resumed
   * before the visibilitychange dispose ran), rebuild once and retry.
   * Capped at one retry — non-device-loss errors propagate untouched
   * so transient app errors don't thrash the model load.
   */
  const embedWithRecovery = useCallback(
    async (
      info: EmbeddingSetModelInfo,
      text: string,
      purpose: 'document' | 'query',
      options?: EmbeddingExecutionOptions
    ): Promise<number[]> => {
      options?.signal?.throwIfAborted();
      const embedder = await ensureEmbedderReady(info);
      options?.signal?.throwIfAborted();
      try {
        return await embedText(embedder, text, purpose, options);
      } catch (error) {
        if (options?.signal?.aborted) {
          options.signal.throwIfAborted();
        }
        if (isAbortError(error)) {
          throw error;
        }
        if (!isDeviceLossError(error)) {
          throw error;
        }
        logger.warn('WebGPU device loss detected; rebuilding embedder and retrying once', {
          error: error instanceof Error ? error.message : String(error),
        });
        const refreshed = await recoverEmbedderAfterDeviceLoss(embedder, info);
        options?.signal?.throwIfAborted();
        return embedText(refreshed, text, purpose, options);
      }
    },
    [ensureEmbedderReady, recoverEmbedderAfterDeviceLoss]
  );

  const embedDocumentWithRecovery = useCallback(
    (info: EmbeddingSetModelInfo, text: string) => embedWithRecovery(info, text, 'document'),
    [embedWithRecovery]
  );

  const embedQueryWithRecovery = useCallback(
    (info: EmbeddingSetModelInfo, text: string, options?: EmbeddingExecutionOptions) =>
      embedWithRecovery(info, text, 'query', options),
    [embedWithRecovery]
  );

  return { embedDocumentWithRecovery, embedQueryWithRecovery, ensureEmbedderReady };
}
