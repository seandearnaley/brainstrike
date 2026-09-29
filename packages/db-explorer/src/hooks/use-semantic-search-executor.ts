/**
 * useSemanticSearchExecutor Hook
 *
 * Creates a search executor function for the SemanticSearchProvider
 * that performs vector similarity search using the chunk repository.
 * Supports both vector-only and hybrid (vector + FTS) retrieval modes.
 */

import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type {
  ChunkSearchResult,
  DrizzleFileRecordRepository,
  ElectronFileRecordRepository,
  HybridSearchResult,
  IFileChunkRepository,
} from '@brainstrike/db';
import {
  createHybridSearchService,
  DEFAULT_HYBRID_SOURCE_LIMIT,
  normalizeRRFScores,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { clampResultLimit, type SearchConfig, type SemanticSearchResult } from '@brainstrike/ui';
import {
  type EmbeddingSetModelInfo,
  useSharedSearchEmbedder,
} from '@brainstrike/vector-management';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  buildLocalEmbeddingModelConfigMap,
  resolveEmbeddingSetModelInfo,
} from '../utils/embedding-models';

/**
 * A one-shot scoped retrieval: run `query` against `embeddingSetId` with the
 * given tuning and return scored chunks. Previously declared alongside the
 * SemanticSearchProvider, which lost its last consumer when the Collection
 * Browser was retired (BST-1213/1214); the executor is now the only owner.
 */
export type SearchExecutor = (
  query: string,
  config: SearchConfig,
  embeddingSetId: string | null
) => Promise<SemanticSearchResult[]>;

const logger = createLogger('SemanticSearchExecutor');

/** Default weight for vector search in hybrid mode */
const DEFAULT_VECTOR_WEIGHT = 1.0;
/** Default weight for FTS in hybrid mode */
const DEFAULT_FTS_WEIGHT = 1.0;
/**
 * Floor for each RRF source pool. Imported from the service (single source of
 * truth) so it can't drift from the service's own default. RRF reranks best
 * when the candidate pool is larger than the final cut, so we grow the pools to
 * honor large limits but never shrink below this — a small resultLimit (e.g.
 * the default 20) must still oversample.
 */
const HYBRID_MIN_SOURCE_POOL = DEFAULT_HYBRID_SOURCE_LIMIT;

interface UseSemanticSearchExecutorOptions {
  chunkRepository: IFileChunkRepository | null;
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
      chunkId: result.chunk.id,
      chunkIndex: result.chunk.chunkIndex,
      content: result.chunk.content,
      fileName: fileInfo.name,
      filePath: fileInfo.path,
      fileRecordId: result.chunk.fileRecordId,
      fileSize: fileInfo.size,
      nodeId: `chunk-${result.chunk.id}`,
      similarity: result.similarity,
      tokenCount: result.chunk.tokenCount,
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
    // Prefer the loaded vector's length, but fall back to the projected dimension
    // count (vector_dims) when the search omitted the heavy embedding payload.
    const dims = result.chunk.embedding?.length ?? result.chunk.embeddingDimensions;
    if (dims !== undefined && dims > 0) {
      searchResult.embeddingDimensions = dims;
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
      logger.warn('Failed to fetch file record', { error: result.reason, fileId });
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
      chunkId: result.chunk.id,
      chunkIndex: result.chunk.chunkIndex,
      content: result.chunk.content,
      fileName: fileInfo.name,
      filePath: fileInfo.path,
      fileRecordId: result.chunk.fileRecordId,
      fileSize: fileInfo.size,
      nodeId: `chunk-${result.chunk.id}`,
      // Use RRF score as similarity (already normalized 0-1)
      similarity: result.rrfScore,
      // Include hybrid metadata
      sourceCount: result.sourceCount,
      tokenCount: result.chunk.tokenCount,
    };

    // Add optional fields if present
    if (result.chunk.embeddingSetId) {
      searchResult.embeddingSetId = result.chunk.embeddingSetId;
    }
    // Hybrid source pools omit the heavy embedding vector but project its
    // dimension count, so prefer the loaded length and fall back to that.
    const dims = result.chunk.embedding?.length ?? result.chunk.embeddingDimensions;
    if (dims !== undefined && dims > 0) {
      searchResult.embeddingDimensions = dims;
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
  chunkRepository: IFileChunkRepository,
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository
): Promise<SemanticSearchResult[]> {
  logger.info('Using hybrid search (vector + FTS with RRF fusion)', {
    ftsWeight: config.ftsWeight ?? DEFAULT_FTS_WEIGHT,
    vectorWeight: config.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
  });

  const hybridService = createHybridSearchService(chunkRepository);
  const hybridResponse = await hybridService.search(query, embedding, {
    embeddingSetId,
    ftsLimit: Math.max(HYBRID_MIN_SOURCE_POOL, config.resultLimit),
    ftsWeight: config.ftsWeight ?? DEFAULT_FTS_WEIGHT,
    // The search UI doesn't render FTS headlines, so skip the costly per-row
    // ts_headline generation across the (up to 2,000-row) FTS source pool.
    includeHeadline: false,
    limit: config.resultLimit,
    // RRF fusion can only emit as many unique hits as the union of its source
    // pools holds. The service defaults both pools to 50, which silently caps
    // hybrid results at ~100 regardless of `limit`. Grow each pool to the
    // requested limit so a large resultLimit is reachable, but never shrink
    // below the default — RRF needs a candidate pool larger than the final cut.
    vectorLimit: Math.max(HYBRID_MIN_SOURCE_POOL, config.resultLimit),
    vectorThreshold: config.threshold,
    vectorWeight: config.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    ...filterOptions,
  });

  logger.info('Hybrid search completed', {
    ftsResultCount: hybridResponse.metadata.ftsResultCount,
    resultCount: hybridResponse.results.length,
    totalMs: hybridResponse.metadata.totalMs,
    vectorResultCount: hybridResponse.metadata.vectorResultCount,
  });

  // Normalize RRF scores to 0-1 range for consistency with vector similarity
  const normalizedResults = normalizeRRFScores(
    hybridResponse.results.map((r) => ({
      contributions: [],
      id: r.chunk.id,
      rrfScore: r.rrfScore,
      sourceCount: r.sourceCount,
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
  chunkRepository: IFileChunkRepository,
  fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository
): Promise<SemanticSearchResult[]> {
  const searchResults = await chunkRepository.searchSimilar(embedding, {
    embeddingSetId,
    // Result rows only need the embedding DIMENSION (preserved via vector_dims),
    // never the vector values — so project the heavy payload away.
    includeEmbedding: false,
    limit: config.resultLimit,
    threshold: config.threshold,
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
 * Creates a search executor for semantic search (hosted today by the
 * collection debug drawer's retrieval preview).
 */
export function useSemanticSearchExecutor({
  chunkRepository,
  fileRepository,
}: UseSemanticSearchExecutorOptions): SearchExecutor | undefined {
  const previousAvailabilityRef = useRef<boolean | null>(null);
  const db = usePGliteDatabase();
  // Selector-scoped subscription: this hook only consumes `models`. A bare
  // useModelRegistryStore() would re-render the whole host panel on every
  // store update — including per-tick setDownloadProgress during model
  // downloads.
  const models = useModelRegistryStore((state) => state.models);
  // Shared embedder resolution + WebGPU device-loss recovery lives in
  // @brainstrike/vector-management so the workspace-search feature can reuse it.
  // The provider owns ONE cache shared across every search surface (a private
  // per-hook embedder would double local-model memory when both are live).
  const { embedQueryWithRecovery } = useSharedSearchEmbedder();

  useEnsureModelRegistry({ db });

  const modelConfigMap = useMemo(() => buildLocalEmbeddingModelConfigMap(models), [models]);
  const getEmbeddingSetModelInfo = useCallback(
    async (embeddingSetId: string): Promise<EmbeddingSetModelInfo> => {
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
      const resolved = resolveEmbeddingSetModelInfo(
        {
          dimensions: parseStrictEmbeddingDimensions(row.dimensions),
          modelKey: row.modelKey,
        },
        modelConfigMap
      );
      // Bridge the local-only optional `modelConfig` to the hook's explicit
      // `null` for hosted providers (exactOptionalPropertyTypes).
      return {
        dimensions: resolved.dimensions,
        modelConfig: resolved.modelConfig ?? null,
        modelKey: resolved.modelKey,
      };
    },
    [db, modelConfigMap]
  );

  /**
   * Get the model info for the active embedding set
   */
  const getModelInfo = useCallback(
    async (embeddingSetId: string | null): Promise<EmbeddingSetModelInfo> => {
      if (!embeddingSetId) {
        throw new Error('Select an active embedding set to perform semantic search');
      }
      return getEmbeddingSetModelInfo(embeddingSetId);
    },
    [getEmbeddingSetModelInfo]
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
        config,
        embeddingSetId,
        hasChunkRepo: !!chunkRepository,
        hasFileRepo: !!fileRepository,
        query: query.slice(0, 50),
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
        dimensions: modelInfo.dimensions,
        modelKey: modelInfo.modelKey,
      });

      // Generate query embedding. The shared hook resolves (and caches) the
      // embedder and transparently rebuilds+retries once on a WebGPU
      // device-loss error; other errors propagate untouched.
      logger.info('Generating query embedding...');
      const embedding = await embedQueryWithRecovery(modelInfo, query);
      logger.info('Query embedding generated', { embeddingLength: embedding.length });

      // Defense-in-depth: the result-limit ceiling is enforced in the UI input,
      // but a persisted or programmatic resultLimit must not size the hybrid
      // source-pool fan-out unbounded here, where the cost is actually paid.
      // Clamp at the source of truth so the bound lives where it matters.
      const safeConfig: SearchConfig = {
        ...config,
        resultLimit: clampResultLimit(config.resultLimit),
      };

      // Build retrieval filter options (BST-172, BST-175)
      const filterOptions = buildRetrievalFilterOptions(safeConfig);
      const retrievalMode = safeConfig.retrievalMode ?? 'hybrid';

      logger.info('Searching for similar chunks...', {
        filterMode: getFilterModeLabel(filterOptions),
        hasFilePaths: Boolean(safeConfig.filePaths?.length),
        hasSnapshotId: Boolean(safeConfig.selectionSnapshotId),
        retrievalMode,
      });

      // Perform search based on retrieval mode
      if (retrievalMode === 'hybrid') {
        return executeHybridSearch(
          query,
          embedding,
          safeConfig,
          embeddingSetId,
          filterOptions,
          chunkRepository,
          fileRepository
        );
      }

      // Vector-only search (default)
      return executeVectorSearch(
        embedding,
        safeConfig,
        embeddingSetId,
        filterOptions,
        chunkRepository,
        fileRepository
      );
    },
    [chunkRepository, fileRepository, getModelInfo, embedQueryWithRecovery]
  );

  const hasExecutor = Boolean(chunkRepository && fileRepository);

  useEffect(() => {
    if (previousAvailabilityRef.current === hasExecutor) {
      return;
    }

    previousAvailabilityRef.current = hasExecutor;
    logger.debug('Semantic search executor availability changed', {
      hasChunkRepo: !!chunkRepository,
      hasExecutor,
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
