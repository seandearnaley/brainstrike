/**
 * useSemanticSearchExecutor Hook
 *
 * Creates a search executor function for the SemanticSearchProvider
 * that performs vector similarity search using the chunk repository.
 * Supports both vector-only and hybrid (vector + FTS) retrieval modes.
 */

import type {
  ChunkSearchResult,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  HybridSearchResult,
} from '@brainstrike/db';
import { createHybridSearchService, normalizeRRFScores, usePGliteDatabase } from '@brainstrike/db';
import type { EmbeddingProviderConfig } from '@brainstrike/embeddings';
import {
  isHostedProvider,
  type EmbeddingModelConfig as ModelConfig,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import type { SearchConfig, SemanticSearchResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SearchExecutor } from '../contexts/semantic-search-context';
import {
  buildLocalEmbeddingModelConfigMap,
  type EffectiveModelInfo,
  resolveEmbeddingSetModelInfo,
} from '../utils/embedding-models';

const logger = createLogger('SemanticSearchExecutor');

/** Default weight for vector search in hybrid mode */
const DEFAULT_VECTOR_WEIGHT = 1.0;
/** Default weight for FTS in hybrid mode */
const DEFAULT_FTS_WEIGHT = 1.0;

// `runtime` lets the visibility-change handler avoid disposing embedders
// that can't suffer GPUDevice loss (hosted providers have no local model,
// wasm runs on CPU). Re-initializing a 300MB WASM model on every
// background/foreground cycle would be a real perf regression.
type EmbedderRuntime = 'webgpu' | 'wasm' | 'hosted';

interface SearchEmbedder {
  dispose?: () => Promise<void> | void;
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
  runtime: EmbedderRuntime;
}

type EmbedderError =
  | { message: string }
  | { originalError: { message: string }; type: string }
  | { type: string };

interface UseSemanticSearchExecutorOptions {
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
}

function parseStrictEmbeddingDimensions(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    throw new Error('Active embedding set dimensions are missing or invalid.');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new Error('Active embedding set dimensions are missing or invalid.');
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
    runtime: 'hosted',
    embedQuery: async (text: string) => {
      const result = await provider.embed({ text, modelId });
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
    runtime: devicePreference,
    embedQuery: async (text: string) => {
      logger.info('Generating query embedding with local model...');
      const result = await svc.generateQueryEmbedding(text);
      return { embedding: Array.from(result.embedding) };
    },
    dispose: () => svc.dispose(),
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

interface RetrievalFilterOptions {
  filePaths?: string[];
  selectionSnapshotId?: string;
}

interface SearchFileInfo {
  chunksCount?: number;
  name: string;
  path: string;
  size: number;
  tokenCount?: number;
}

/**
 * Build retrieval filter options, preferring selectionSnapshotId over filePaths
 * to avoid MAX_INLINE_FILE_PATHS (500) limit.
 */
function buildRetrievalFilterOptions(config: SearchConfig): RetrievalFilterOptions {
  if (config.selectionSnapshotId) {
    return { selectionSnapshotId: config.selectionSnapshotId };
  }
  if (config.filePaths?.length) {
    return { filePaths: [...config.filePaths] };
  }
  return {};
}

/**
 * Transform chunk search results to SemanticSearchResult format.
 * Uses ChunkSearchResult from @brainstrike/db which provides full FileChunk objects.
 */
function transformToSearchResults(
  searchResults: ChunkSearchResult[],
  fileRecordsMap: Map<string, SearchFileInfo>
): SemanticSearchResult[] {
  return searchResults.map((result) => {
    const fileInfo = fileRecordsMap.get(result.chunk.fileRecordId) ?? {
      name: 'Unknown',
      path: '',
      size: 0,
    };

    const searchResult: SemanticSearchResult = {
      nodeId: `chunk-${result.chunk.id}`,
      chunkId: result.chunk.id,
      chunkIndex: result.chunk.chunkIndex,
      fileRecordId: result.chunk.fileRecordId,
      similarity: result.similarity,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount,
      fileName: fileInfo.name,
      filePath: fileInfo.path,
      fileSize: fileInfo.size,
    };
    if (result.chunk.startLine !== undefined) {
      searchResult.startLine = result.chunk.startLine;
    }
    if (result.chunk.endLine !== undefined) {
      searchResult.endLine = result.chunk.endLine;
    }
    if (result.chunk.startOffset !== undefined) {
      searchResult.startOffset = result.chunk.startOffset;
    }
    if (result.chunk.endOffset !== undefined) {
      searchResult.endOffset = result.chunk.endOffset;
    }
    if (result.chunk.embeddingSetId) {
      searchResult.embeddingSetId = result.chunk.embeddingSetId;
    }
    if (result.chunk.embedding && result.chunk.embedding.length > 0) {
      searchResult.embeddingDimensions = result.chunk.embedding.length;
    }
    return searchResult;
  });
}

/**
 * Build a map of file records for enriching search results with file metadata.
 * Extracts unique file IDs and fetches their records in parallel.
 * Uses Promise.allSettled for graceful degradation - partial results are returned
 * even if some file lookups fail.
 */
async function buildFileRecordsMap(
  fileIds: string[],
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository
): Promise<Map<string, SearchFileInfo>> {
  const uniqueFileIds = Array.from(new Set(fileIds));
  const results = await Promise.allSettled(
    uniqueFileIds.map(async (fileId) => {
      const record = await fileRepository.findById(fileId);
      return { fileId, record };
    })
  );

  const fileRecordsMap = new Map<string, SearchFileInfo>();
  for (const [index, result] of results.entries()) {
    const fileId = uniqueFileIds[index];
    // Skip if fileId is undefined (should never happen in practice)
    if (!fileId) {
      continue;
    }
    if (result.status === 'fulfilled') {
      const record = result.value.record;
      const info = record
        ? {
            name: record.name,
            path: record.path,
            size: record.size,
            ...(record.tokenCount === undefined ? {} : { tokenCount: record.tokenCount }),
            ...(record.chunksCount === undefined ? {} : { chunksCount: record.chunksCount }),
          }
        : { name: 'Unknown file', path: '(unavailable)', size: 0 };
      fileRecordsMap.set(fileId, info);
    } else {
      // Log failed lookups but continue with partial results
      logger.warn('Failed to fetch file record', { fileId, error: result.reason });
      fileRecordsMap.set(fileId, { name: 'Error loading', path: '(error)', size: 0 });
    }
  }

  return fileRecordsMap;
}

/**
 * Transform hybrid search results to SemanticSearchResult format.
 * Uses the RRF score as the similarity score (already 0-1 after normalization).
 * Uses HybridSearchResult from @brainstrike/db which provides full FileChunk objects.
 */
function transformHybridResults(
  hybridResults: HybridSearchResult[],
  fileRecordsMap: Map<string, SearchFileInfo>
): SemanticSearchResult[] {
  return hybridResults.map((result) => {
    const fileInfo = fileRecordsMap.get(result.chunk.fileRecordId) ?? {
      name: 'Unknown',
      path: '',
      size: 0,
    };

    const searchResult: SemanticSearchResult = {
      nodeId: `chunk-${result.chunk.id}`,
      chunkId: result.chunk.id,
      chunkIndex: result.chunk.chunkIndex,
      fileRecordId: result.chunk.fileRecordId,
      // Use RRF score as similarity (already normalized 0-1)
      similarity: result.rrfScore,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount,
      fileName: fileInfo.name,
      filePath: fileInfo.path,
      fileSize: fileInfo.size,
      // Include hybrid metadata
      sourceCount: result.sourceCount,
    };

    // Add optional fields if present
    if (result.chunk.embeddingSetId) {
      searchResult.embeddingSetId = result.chunk.embeddingSetId;
    }
    if (result.chunk.embedding && result.chunk.embedding.length > 0) {
      searchResult.embeddingDimensions = result.chunk.embedding.length;
    }
    if (result.vectorSimilarity !== undefined) {
      searchResult.vectorSimilarity = result.vectorSimilarity;
    }
    if (result.ftsRank !== undefined) {
      searchResult.ftsRank = result.ftsRank;
    }
    if (result.headline) {
      searchResult.headline = result.headline;
    }

    return searchResult;
  });
}

/**
 * Execute hybrid search combining vector and FTS with RRF fusion.
 */
async function executeHybridSearch(
  query: string,
  embedding: number[],
  config: SearchConfig,
  embeddingSetId: string,
  filterOptions: RetrievalFilterOptions,
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository,
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository
): Promise<SemanticSearchResult[]> {
  logger.info('Using hybrid search (vector + FTS with RRF fusion)', {
    vectorWeight: config.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    ftsWeight: config.ftsWeight ?? DEFAULT_FTS_WEIGHT,
  });

  const hybridService = createHybridSearchService(chunkRepository);
  const hybridResponse = await hybridService.search(query, embedding, {
    limit: config.resultLimit,
    vectorThreshold: config.threshold,
    embeddingSetId,
    vectorWeight: config.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    ftsWeight: config.ftsWeight ?? DEFAULT_FTS_WEIGHT,
    ...filterOptions,
  });

  logger.info('Hybrid search completed', {
    resultCount: hybridResponse.results.length,
    vectorResultCount: hybridResponse.metadata.vectorResultCount,
    ftsResultCount: hybridResponse.metadata.ftsResultCount,
    totalMs: hybridResponse.metadata.totalMs,
  });

  // Normalize RRF scores to 0-1 range for consistency with vector similarity
  const normalizedResults = normalizeRRFScores(
    hybridResponse.results.map((r) => ({
      id: r.chunk.id,
      rrfScore: r.rrfScore,
      sourceCount: r.sourceCount,
      contributions: [],
    }))
  );

  // Map normalized scores back to results
  const scoreMap = new Map(normalizedResults.map((r) => [r.id, r.rrfScore]));
  const resultsWithNormalizedScores = hybridResponse.results.map((r) => ({
    ...r,
    rrfScore: scoreMap.get(r.chunk.id) ?? r.rrfScore,
  }));

  // Build file records map and transform to SemanticSearchResult format
  const fileRecordsMap = await buildFileRecordsMap(
    hybridResponse.results.map((r) => r.chunk.fileRecordId),
    fileRepository
  );
  return transformHybridResults(resultsWithNormalizedScores, fileRecordsMap);
}

/**
 * Execute vector-only similarity search.
 */
async function executeVectorSearch(
  embedding: number[],
  config: SearchConfig,
  embeddingSetId: string,
  filterOptions: RetrievalFilterOptions,
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository,
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository
): Promise<SemanticSearchResult[]> {
  const searchResults = await chunkRepository.searchSimilar(embedding, {
    limit: config.resultLimit,
    threshold: config.threshold,
    embeddingSetId,
    ...filterOptions,
  });
  logger.info('Vector search completed', { resultCount: searchResults.length });

  // Build file records map and transform to SemanticSearchResult format
  const fileRecordsMap = await buildFileRecordsMap(
    searchResults.map((r) => r.chunk.fileRecordId),
    fileRepository
  );
  return transformToSearchResults(searchResults, fileRecordsMap);
}

/**
 * Get the filter mode label for logging.
 */
function getFilterModeLabel(filterOptions: RetrievalFilterOptions): string {
  if (filterOptions.selectionSnapshotId) {
    return 'snapshot';
  }
  if (filterOptions.filePaths) {
    return 'filePaths';
  }
  return 'none';
}

/**
 * Creates a search executor for semantic search in the collection browser
 */
export function useSemanticSearchExecutor({
  chunkRepository,
  fileRepository,
}: UseSemanticSearchExecutorOptions): SearchExecutor | undefined {
  const previousAvailabilityRef = useRef<boolean | null>(null);
  const db = usePGliteDatabase();
  const { models } = useModelRegistryStore();
  const devicePref = useVectorPreferencesStore((state) => state.devicePref);
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentModelKeyRef = useRef<string | null>(null);
  // Track in-flight initialization to prevent race conditions (BST-175 fix)
  const initializingPromiseRef = useRef<Promise<SearchEmbedder> | null>(null);

  useEnsureModelRegistry({ db });

  // Dispose + null the cached embedder. Shared by unmount cleanup,
  // visibilitychange-hidden, and post-device-loss recovery so each path
  // releases the WebGPU GPUDevice the same way.
  //
  // Intentionally does NOT clear `initializingPromiseRef`: that ref is the
  // dedup gate in `ensureEmbedderReady`, and clearing it during an in-flight
  // init lets a concurrent caller spawn a second model load while the first
  // is still running. Soft-overwrite semantic instead — if dispose runs
  // while an init is in flight, the init completes and writes a (possibly
  // stale-GPU) embedder into `embedderRef.current`. The next search will
  // either reuse it (cheap if still valid) or hit a device-loss error which
  // routes through the retry path in `searchExecutor` to rebuild fresh.
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
        reason,
        error: error instanceof Error ? error.message : String(error),
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

  const modelConfigMap = useMemo(() => buildLocalEmbeddingModelConfigMap(models), [models]);
  const getEmbeddingSetModelInfo = useCallback(
    async (embeddingSetId: string): Promise<EffectiveModelInfo> => {
      if (!db) {
        throw new Error('Database is not available to resolve the active embedding set.');
      }
      const res = await db.query<{ modelKey: string; dimensions: number }>(
        'SELECT model_key AS "modelKey", dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
        [embeddingSetId]
      );
      const row = res.rows[0];
      if (!row?.modelKey) {
        throw new Error('Active embedding set is missing a model.');
      }
      return resolveEmbeddingSetModelInfo(
        {
          modelKey: row.modelKey,
          dimensions: parseStrictEmbeddingDimensions(row.dimensions),
        },
        modelConfigMap
      );
    },
    [db, modelConfigMap]
  );

  /**
   * Get the model info for the active embedding set
   */
  const getModelInfo = useCallback(
    async (embeddingSetId: string | null): Promise<EffectiveModelInfo> => {
      if (!embeddingSetId) {
        throw new Error('Select an active embedding set to perform semantic search');
      }
      return getEmbeddingSetModelInfo(embeddingSetId);
    },
    [getEmbeddingSetModelInfo]
  );

  /**
   * Create hosted provider config
   */
  const createHostedConfig = useCallback(
    (provider: string, modelId: string, dimensions: number): EmbeddingProviderConfig => {
      if (provider === 'openai') {
        return { runtime: 'hosted', provider: 'openai', modelId, dimensions };
      }
      if (provider === 'google') {
        return {
          runtime: 'hosted',
          provider: 'google',
          modelId,
          outputDimensionality: dimensions,
        };
      }
      if (provider === 'cohere') {
        return {
          runtime: 'hosted',
          provider: 'cohere',
          modelId,
          inputType: 'search_query',
        };
      }
      if (provider === 'voyage') {
        return { runtime: 'hosted', provider: 'voyage', modelId, inputType: 'query' };
      }
      throw new Error(`Unsupported hosted provider: ${provider}`);
    },
    []
  );

  /**
   * Ensure embedder is ready for the given model.
   * Uses promise caching to prevent race conditions when multiple concurrent
   * calls attempt to initialize the embedder simultaneously.
   */
  const ensureEmbedderReady = useCallback(
    async ({ modelKey, dimensions, modelConfig }: EffectiveModelInfo): Promise<SearchEmbedder> => {
      logger.info('ensureEmbedderReady called', { modelKey, dimensions });

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
    [createHostedConfig, devicePref]
  );

  /**
   * The search executor function
   */
  const searchExecutor: SearchExecutor = useCallback(
    async (
      query: string,
      config: SearchConfig,
      embeddingSetId: string | null
    ): Promise<SemanticSearchResult[]> => {
      logger.info('searchExecutor called', {
        query: query.slice(0, 50),
        embeddingSetId,
        config,
        hasChunkRepo: !!chunkRepository,
        hasFileRepo: !!fileRepository,
      });

      if (!(chunkRepository && fileRepository)) {
        throw new Error('Repositories not available');
      }

      if (!embeddingSetId) {
        throw new Error('Select an active embedding set to perform semantic search');
      }

      // Get model info for the embedding set
      logger.info('Getting model info for embedding set...');
      const modelInfo = await getModelInfo(embeddingSetId);
      logger.info('Model info retrieved', {
        modelKey: modelInfo.modelKey,
        dimensions: modelInfo.dimensions,
      });

      // Ensure embedder is ready
      logger.info('Initializing embedder...');
      const embedder = await ensureEmbedderReady(modelInfo);
      logger.info('Embedder ready');

      // Generate query embedding. If the cached embedder's GPUDevice was
      // invalidated (e.g. visible renderer was backgrounded then resumed
      // before the visibilitychange dispose ran), rebuild once and retry.
      // Capped at one retry — non-device-loss errors propagate untouched
      // so transient app errors don't thrash the model load.
      logger.info('Generating query embedding...');
      let embedding: number[];
      try {
        ({ embedding } = await embedder.embedQuery(query));
      } catch (error) {
        if (!isDeviceLossError(error)) {
          throw error;
        }
        logger.warn('WebGPU device loss detected; rebuilding embedder and retrying once', {
          error: error instanceof Error ? error.message : String(error),
        });
        await disposeCachedEmbedder('device-loss');
        const refreshed = await ensureEmbedderReady(modelInfo);
        ({ embedding } = await refreshed.embedQuery(query));
      }
      logger.info('Query embedding generated', { embeddingLength: embedding.length });

      // Build retrieval filter options (BST-172, BST-175)
      const filterOptions = buildRetrievalFilterOptions(config);
      const retrievalMode = config.retrievalMode ?? 'hybrid';

      logger.info('Searching for similar chunks...', {
        retrievalMode,
        hasFilePaths: Boolean(config.filePaths?.length),
        hasSnapshotId: Boolean(config.selectionSnapshotId),
        filterMode: getFilterModeLabel(filterOptions),
      });

      // Perform search based on retrieval mode
      if (retrievalMode === 'hybrid') {
        return executeHybridSearch(
          query,
          embedding,
          config,
          embeddingSetId,
          filterOptions,
          chunkRepository,
          fileRepository
        );
      }

      // Vector-only search (default)
      return executeVectorSearch(
        embedding,
        config,
        embeddingSetId,
        filterOptions,
        chunkRepository,
        fileRepository
      );
    },
    [chunkRepository, fileRepository, getModelInfo, ensureEmbedderReady, disposeCachedEmbedder]
  );

  const hasExecutor = Boolean(chunkRepository && fileRepository);

  useEffect(() => {
    if (previousAvailabilityRef.current === hasExecutor) {
      return;
    }

    previousAvailabilityRef.current = hasExecutor;
    logger.debug('Semantic search executor availability changed', {
      hasExecutor,
      hasChunkRepo: !!chunkRepository,
      hasFileRepo: !!fileRepository,
    });
  }, [chunkRepository, fileRepository, hasExecutor]);

  // Only return executor if repositories are available
  if (!hasExecutor) {
    return;
  }

  // Removed noisy debug log (was: logger.debug('Semantic search executor ready'));
  return searchExecutor;
}
