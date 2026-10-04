/**
 * Desktop wiring for the `brainstrike.hybridSearch` assistant tool.
 *
 * An injected native capability uses the existing main-owned scoped reader and
 * workspace-search RRF60 fusion over BM25, grep and vector pools. Without that
 * capability, the retained PG path uses HybridSearchService. Both paths keep
 * explicit collection/root scope and fail the whole call when an arm fails.

 */

import {
  fitItemsToCharBudget,
  type HybridSearchInput,
  normalizeOptionalText,
  type RuntimeData,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import {
  DEFAULT_HYBRID_SOURCE_LIMIT,
  FileChunkRepository,
  FileRecordRepository,
  HybridSearchService,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import {
  resolveNativeAssistantCollection,
  searchNativeAssistantChunks,
} from './native-assistant-retrieval';
import {
  assertEmbeddingDimensions,
  buildFileRecordMap,
  generateQueryEmbeddingForSet,
  RETRIEVAL_SAFE_ERROR_MESSAGES,
  type RetrievalToolDependencies,
  resolveEmbeddingSet,
} from './retrieval-tool';
import { resolveOptionalWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantHybridSearchTool');

export const HYBRID_SEARCH_TOOL_ID = NATIVE_TOOL_ID.hybridSearch;

const DEFAULT_LIMIT = 20;
const DEFAULT_VECTOR_THRESHOLD = 0.5;
const DEFAULT_VECTOR_WEIGHT = 1.0;
const DEFAULT_FTS_WEIGHT = 1.0;
/** Per-result content cap so a 20-result payload stays inside the tool output budget. */
const MAX_CONTENT_CHARS_PER_RESULT = 700;

export const HYBRID_SEARCH_ERROR_MESSAGES = {
  invalidQuery: 'Search query must be at least 1 character.',
  missingEmbeddingSet:
    'Select an embedding space or enable the Workspace Index before hybrid search.',
  searchFailed: 'Hybrid search failed. Please try again.',
} as const;

const SAFE_HYBRID_ERROR_MESSAGES = new Set<string>(Object.values(HYBRID_SEARCH_ERROR_MESSAGES));

/** Mirrors `redactToolErrorForLog` in assistant-tools.ts: DB/provider errors can
 * embed request-derived content in `.message`; never log it verbatim. */
function redactErrorForLog(error: unknown): {
  code?: string | number;
  name: string;
  redacted: true;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

export interface HybridSearchToolResultItem {
  chunkIndex: number;
  /** Chunk content, capped per result to respect the tool output budget. */
  content: string;
  fileName?: string;
  filePath?: string;
  /** FTS rank (negated BM25; higher = better, unbounded) when the keyword arm found it. */
  ftsRank?: number;
  headline?: string;
  id: string;
  /** Position in the fused result set (1-indexed). */
  position: number;
  rootName?: string;
  /** Combined RRF score (higher = better). */
  rrfScore: number;
  /** Number of contributing arms (up to 3 for native retrieval) that found this chunk. */
  sourceCount: number;
  vectorSimilarity?: number;
}

export interface HybridSearchToolResult {
  embeddingSetId: string;
  ftsWeight: number;
  hint?: string;
  limit: number;
  metadata: {
    ftsResultCount: number;
    fusedResultCount: number;
    totalMs: number;
    vectorResultCount: number;
  };
  query: string;
  results: HybridSearchToolResultItem[];
  root?: string;
  truncated: boolean;
  vectorWeight: number;
}

function resolveHybridEmbeddingSetId(
  runtimeData: RuntimeData | undefined,
  inputEmbeddingSetId: string | undefined
): string {
  const explicit = normalizeOptionalText(inputEmbeddingSetId);
  if (explicit) {
    return explicit;
  }
  const workspaceIndexSetId = normalizeOptionalText(runtimeData?.workspaceIndexEmbeddingSetId);
  if (
    workspaceIndexSetId &&
    runtimeData?.workspaceIndexingEnabled === true &&
    runtimeData.workspaceIndexStatusState !== 'blocked' &&
    runtimeData.workspaceIndexStatusState !== 'disabled' &&
    runtimeData.workspaceIndexStatusState !== 'error'
  ) {
    return workspaceIndexSetId;
  }
  throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.missingEmbeddingSet);
}

function handleHybridSearchError(error: unknown): never {
  if (error instanceof ToolInputError) {
    // Same invariant as retrieval-tool's handleRetrievalError (BST-1020):
    // ToolInputError is deliberately model-actionable input prose (already
    // path-redacted at its source). Today root resolution runs OUTSIDE this
    // try, so this is structural insurance rather than a behavior change — a
    // refactor moving it inside must not silently genericize the prose.
    throw error;
  }
  const message =
    error instanceof Error ? error.message : HYBRID_SEARCH_ERROR_MESSAGES.searchFailed;
  if (SAFE_HYBRID_ERROR_MESSAGES.has(message) || RETRIEVAL_SAFE_ERROR_MESSAGES.has(message)) {
    throw new Error(message);
  }
  logger.error('Hybrid search tool failed', { error: redactErrorForLog(error) });
  throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.searchFailed);
}

export async function runHybridSearch(
  input: HybridSearchInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {},
  signal?: AbortSignal
): Promise<HybridSearchToolResult> {
  signal?.throwIfAborted();
  const query = input.query.trim();
  if (!query) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.invalidQuery);
  }
  const embeddingSetId = dependencies.nativeIndexSearch
    ? await resolveNativeAssistantCollection(
        dependencies.nativeIndexSearch,
        input.embeddingSetId,
        signal
      )
    : resolveHybridEmbeddingSetId(runtimeData, input.embeddingSetId);
  // Root resolution stays OUTSIDE the sanitizing catch: its errors are locally
  // constructed, user-actionable messages ("Open folders: ...") the model needs.
  const root = resolveOptionalWorkspaceRoot(runtimeData, input.root);

  try {
    const db = await getDatabase();
    signal?.throwIfAborted();
    const embeddingSet = await resolveEmbeddingSet(db, embeddingSetId);
    if (dependencies.nativeIndexSearch) {
      const started = performance.now();
      const native = await searchNativeAssistantChunks({
        ...input,
        capability: dependencies.nativeIndexSearch,
        embeddingHostManager: dependencies.embeddingHostManager,
        embeddingSet,
        embeddingSetId,
        mode: 'hybrid',
        query,
        rootId: root?.rootId,
        signal,
        threshold: input.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD,
      });
      const fileMap = await buildFileRecordMap(
        new FileRecordRepository(db),
        db,
        native.hits.map(({ hit }) => hit.fileId)
      );
      await native.assertCurrent();
      const items: HybridSearchToolResultItem[] = native.hits.map((result, index) => {
        const file = fileMap.get(result.hit.fileId);
        if (result.hit.chunkIndex === null) {
          throw new ToolInputError('Native source chunk metadata is unavailable.');
        }
        return {
          chunkIndex: result.hit.chunkIndex,
          content: result.hit.content.slice(0, MAX_CONTENT_CHARS_PER_RESULT),
          id: result.hit.chunkId,
          position: index + 1,
          rrfScore: result.rrfScore,
          sourceCount: result.sourceCount,
          ...(file?.name === undefined ? {} : { fileName: file.name }),
          ...(file?.path === undefined ? {} : { filePath: file.path }),
          ...(file?.rootName ? { rootName: file.rootName } : {}),
          ...(result.ftsRank === undefined ? {} : { ftsRank: result.ftsRank }),
          ...(result.similarity === undefined ? {} : { vectorSimilarity: result.similarity }),
        };
      });
      const buildResult = (kept: HybridSearchToolResultItem[]): HybridSearchToolResult => {
        const truncated = native.truncated || kept.length < items.length;
        return {
          embeddingSetId,
          ftsWeight: 1,
          limit: native.limit,
          metadata: {
            ftsResultCount: native.ftsResultCount,
            fusedResultCount: items.length,
            totalMs: performance.now() - started,
            vectorResultCount: native.vectorResultCount,
          },
          query,
          results: kept,
          truncated,
          vectorWeight: 1,
          ...(root ? { root: root.displayName } : {}),
          ...(truncated
            ? {
                hint:
                  native.hint ??
                  'Native hybrid results exceed the output budget. Narrow the query or root scope.',
              }
            : {}),
        };
      };
      return fitItemsToCharBudget(items, buildResult).result;
    }
    const embedding = await generateQueryEmbeddingForSet(embeddingSet, query, dependencies, signal);
    signal?.throwIfAborted();
    assertEmbeddingDimensions(embeddingSet.dimensions, embedding.length);

    const limit = input.limit ?? DEFAULT_LIMIT;
    const vectorWeight = input.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const ftsWeight = input.ftsWeight ?? DEFAULT_FTS_WEIGHT;
    const chunkRepository = new FileChunkRepository(db);
    const service = new HybridSearchService(chunkRepository);
    // Grow BOTH source pools with the requested limit (never shrink below the
    // 50 default) so RRF reranks from pools at least as large as the final
    // cut — mirrors the UI search paths (workspace-search-executor).
    const sourcePoolLimit = Math.max(DEFAULT_HYBRID_SOURCE_LIMIT, limit);
    const { results, metadata } = await service.search(query, embedding, {
      embeddingSetId,
      ftsLimit: sourcePoolLimit,
      ftsWeight,
      // The model never renders the per-candidate headline pool; keep the cheap path.
      includeHeadline: false,
      limit,
      vectorLimit: sourcePoolLimit,
      vectorThreshold: input.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD,
      vectorWeight,
      ...(input.chunkType === undefined ? {} : { chunkType: input.chunkType }),
      ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
      ...(root === undefined ? {} : { rootIds: [root.rootId] }),
    });

    const fileRecordIds = Array.from(new Set(results.map((result) => result.chunk.fileRecordId)));
    const fileMap = await buildFileRecordMap(new FileRecordRepository(db), db, fileRecordIds);
    signal?.throwIfAborted();

    const items: HybridSearchToolResultItem[] = results.map((result) => {
      const fileInfo = fileMap.get(result.chunk.fileRecordId);
      return {
        chunkIndex: result.chunk.chunkIndex,
        content: result.chunk.content.slice(0, MAX_CONTENT_CHARS_PER_RESULT),
        id: result.chunk.id,
        position: result.position,
        rrfScore: result.rrfScore,
        sourceCount: result.sourceCount,
        ...(fileInfo?.name === undefined ? {} : { fileName: fileInfo.name }),
        ...(fileInfo?.path === undefined ? {} : { filePath: fileInfo.path }),
        ...(fileInfo?.rootName ? { rootName: fileInfo.rootName } : {}),
        ...(result.ftsRank === undefined ? {} : { ftsRank: result.ftsRank }),
        ...(result.headline === undefined ? {} : { headline: result.headline }),
        ...(result.vectorSimilarity === undefined
          ? {}
          : { vectorSimilarity: result.vectorSimilarity }),
      };
    });

    // Self-bound the result list to the native-tool output budget (anti-thrash
    // contract): return a SUCCESSFUL partial result with a hint, never a size error.
    const buildResult = (kept: HybridSearchToolResultItem[]): HybridSearchToolResult => {
      const truncated = kept.length < items.length;
      return {
        embeddingSetId,
        ftsWeight,
        limit,
        metadata: {
          ftsResultCount: metadata.ftsResultCount,
          fusedResultCount: metadata.fusedResultCount,
          totalMs: metadata.totalMs,
          vectorResultCount: metadata.vectorResultCount,
        },
        query,
        results: kept,
        truncated,
        vectorWeight,
        ...(root === undefined ? {} : { root: root.displayName }),
        ...(truncated
          ? {
              hint: `Showing ${kept.length} of ${items.length} fused results. Narrow with filePaths, chunkType, or a smaller limit.`,
            }
          : {}),
      };
    };
    return fitItemsToCharBudget(items, buildResult).result;
  } catch (error) {
    if (dependencies.nativeIndexSearch && signal?.aborted && error instanceof AggregateError) {
      throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.searchFailed, { cause: error });
    }
    signal?.throwIfAborted();
    handleHybridSearchError(error);
  }
}
