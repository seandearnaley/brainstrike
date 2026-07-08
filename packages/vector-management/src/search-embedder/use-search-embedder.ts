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

import type { EmbeddingProviderConfig } from '@brainstrike/embeddings';
import {
  isHostedProvider,
  type EmbeddingModelConfig as ModelConfig,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useRef } from 'react';

const logger = createLogger('SearchEmbedder');

// `runtime` lets the visibility-change handler avoid disposing embedders
// that can't suffer GPUDevice loss (hosted providers have no local model,
// wasm runs on CPU). Re-initializing a 300MB WASM model on every
// background/foreground cycle would be a real perf regression.
export type EmbedderRuntime = 'webgpu' | 'wasm' | 'hosted';

export interface SearchEmbedder {
  dispose?: () => Promise<void> | void;
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
  runtime: EmbedderRuntime;
}

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
  /** Embed with the device-loss single-retry semantics from db-explorer. */
  embedQueryWithRecovery: (info: EmbeddingSetModelInfo, text: string) => Promise<number[]>;
  /** Resolves (cached) embedder for the model; throws with named causes (no key, no local model, …). */
  ensureEmbedderReady: (info: EmbeddingSetModelInfo) => Promise<SearchEmbedder>;
}

/**
 * Create a hosted provider embedder
 */
async function createHostedEmbedder(
  providerConfig: EmbeddingProviderConfig,
  modelId: string
): Promise<SearchEmbedder> {
  const { EmbeddingProviderFactory } = await import('@brainstrike/embeddings/factory');
  const providerResult = await EmbeddingProviderFactory.createProvider(providerConfig);
  logger.info('Hosted provider creation result', { ok: providerResult.ok });

  if (!providerResult.ok) {
    throw new Error(
      `Failed to initialize hosted provider: ${
        'message' in providerResult.error ? providerResult.error.message : providerResult.error.type
      }`
    );
  }

  const provider = providerResult.value;
  return {
    embedQuery: async (text: string) => {
      const result = await provider.embed({ modelId, text });
      if (!result.ok) {
        const error: EmbedderError = result.error;
        const msg =
          'message' in error
            ? error.message
            : 'originalError' in error
              ? error.originalError.message
              : error.type;
        throw new Error(`Embedding failed: ${msg}`);
      }
      return { embedding: result.value.embedding };
    },
    runtime: 'hosted',
  };
}

/**
 * Create a local provider embedder
 */
async function createLocalEmbedder(
  modelConfig: ModelConfig,
  devicePreference: 'wasm' | 'webgpu'
): Promise<SearchEmbedder> {
  logger.info('Creating local embedder (SimpleEmbeddingService)', { modelKey: modelConfig.id });
  const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
  const svc = new SimpleEmbeddingService();
  logger.info('Initializing local model...');
  await svc.initializeWithModel(modelConfig, undefined, devicePreference);
  logger.info('Local model initialized');

  return {
    dispose: () => svc.dispose(),
    embedQuery: async (text: string) => {
      logger.info('Generating query embedding with local model...');
      const result = await svc.generateQueryEmbedding(text);
      return { embedding: Array.from(result.embedding) };
    },
    runtime: devicePreference,
  };
}

// WebGPU device-loss recovery (visible-renderer only): we cannot disable
// Chromium background throttling on the visible window (per AGENTS.md), so
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

/**
 * Create hosted provider config
 */
function createHostedConfig(
  provider: string,
  modelId: string,
  dimensions: number
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
      inputType: 'search_query',
      modelId,
      provider: 'cohere',
      runtime: 'hosted',
    };
  }
  if (provider === 'voyage') {
    return { inputType: 'query', modelId, provider: 'voyage', runtime: 'hosted' };
  }
  throw new Error(`Unsupported hosted provider: ${provider}`);
}

/**
 * Shared embedder resolution + device-loss recovery for semantic search.
 */
export function useSearchEmbedder(): UseSearchEmbedderResult {
  const devicePref = useVectorPreferencesStore((state) => state.devicePref);
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentModelKeyRef = useRef<string | null>(null);
  // Track in-flight initialization to prevent race conditions (BST-175 fix)
  const initializingPromiseRef = useRef<Promise<SearchEmbedder> | null>(null);

  // `initializingPromiseRef` is deliberately not cleared — clearing it
  // would break ensureEmbedderReady's dedup gate. Stale embedders are
  // recovered via the device-loss-retry path in `embedQueryWithRecovery`.
  const disposeCachedEmbedder = useCallback(async (reason: string): Promise<void> => {
    const embedder = embedderRef.current;
    if (!embedder) {
      return;
    }
    embedderRef.current = null;
    currentModelKeyRef.current = null;
    if (!embedder.dispose) {
      return;
    }
    try {
      await Promise.resolve(embedder.dispose());
      logger.debug('Disposed cached embedder', { reason });
    } catch (error: unknown) {
      logger.error('Failed to dispose embedder', {
        error: error instanceof Error ? error.message : String(error),
        reason,
      });
    }
  }, []);

  useEffect(
    () => () => {
      void disposeCachedEmbedder('unmount');
    },
    [disposeCachedEmbedder]
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
      if (embedderRef.current?.runtime !== 'webgpu') {
        return;
      }
      void disposeCachedEmbedder('document-hidden');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [disposeCachedEmbedder]);

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

      // Reuse cached embedder if same model
      if (embedderRef.current && currentModelKeyRef.current === modelKey) {
        logger.info('Reusing cached embedder');
        return embedderRef.current;
      }

      // If there's an in-flight initialization for the same model, wait for it
      // This prevents race conditions where multiple concurrent calls both create embedders
      if (initializingPromiseRef.current && currentModelKeyRef.current === modelKey) {
        logger.info('Waiting for in-flight embedder initialization');
        return initializingPromiseRef.current;
      }

      // Create the initialization promise
      const initPromise = (async (): Promise<SearchEmbedder> => {
        try {
          // Dispose previous embedder if exists
          if (embedderRef.current?.dispose) {
            logger.info('Disposing previous embedder');
            await embedderRef.current.dispose();
          }

          // Detect provider type
          const parsed = parseEmbeddingProviderModelKey(modelKey);
          const isHosted = parsed ? isHostedProvider(parsed.provider) : false;
          logger.info('Provider detection', { isHosted });

          // Create appropriate embedder
          let embedder: SearchEmbedder;
          if (parsed && isHostedProvider(parsed.provider)) {
            logger.info('Creating hosted provider', { provider: parsed.provider });
            const providerConfig = createHostedConfig(parsed.provider, parsed.modelId, dimensions);
            embedder = await createHostedEmbedder(providerConfig, parsed.modelId);
          } else {
            if (!modelConfig) {
              throw new Error(
                'No local embedding model configured. Enable one in Settings > Models.'
              );
            }
            embedder = await createLocalEmbedder(modelConfig, devicePref);
          }

          // Cache the result
          embedderRef.current = embedder;
          currentModelKeyRef.current = modelKey;
          return embedder;
        } catch (error) {
          embedderRef.current = null;
          currentModelKeyRef.current = null;
          throw error;
        }
      })();

      // Store the promise so concurrent calls can wait for it
      initializingPromiseRef.current = initPromise;

      try {
        const embedder = await initPromise;
        return embedder;
      } finally {
        // Clear the in-flight promise when done (success or error)
        initializingPromiseRef.current = null;
      }
    },
    [devicePref]
  );

  /**
   * Generate a query embedding. If the cached embedder's GPUDevice was
   * invalidated (e.g. visible renderer was backgrounded then resumed
   * before the visibilitychange dispose ran), rebuild once and retry.
   * Capped at one retry — non-device-loss errors propagate untouched
   * so transient app errors don't thrash the model load.
   */
  const embedQueryWithRecovery = useCallback(
    async (info: EmbeddingSetModelInfo, text: string): Promise<number[]> => {
      const embedder = await ensureEmbedderReady(info);
      try {
        const { embedding } = await embedder.embedQuery(text);
        return embedding;
      } catch (error) {
        if (!isDeviceLossError(error)) {
          throw error;
        }
        logger.warn('WebGPU device loss detected; rebuilding embedder and retrying once', {
          error: error instanceof Error ? error.message : String(error),
        });
        await disposeCachedEmbedder('device-loss');
        const refreshed = await ensureEmbedderReady(info);
        const { embedding } = await refreshed.embedQuery(text);
        return embedding;
      }
    },
    [ensureEmbedderReady, disposeCachedEmbedder]
  );

  return { embedQueryWithRecovery, ensureEmbedderReady };
}
