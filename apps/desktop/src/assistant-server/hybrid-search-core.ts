/**
 * Desktop wiring for the `brainstrike.hybridSearch` assistant tool.
 *
 * The native capability uses the existing main-owned scoped reader and
 * workspace-search RRF60 fusion over BM25, grep and vector pools, keeping
 * explicit collection/root scope and failing the whole call when an arm fails.
 * There is no other similarity path.

 */

import {
  fitItemsToCharBudget,
  type HybridSearchInput,
  normalizeOptionalText,
  type RuntimeData,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  resolveAdmittedRetrievalRoots,
  resolveNativeAssistantCollection,
  searchNativeAssistantChunks,
} from './native-assistant-retrieval';
import {
  assertAdmittedRetrievalFileRoots,
  RETRIEVAL_SAFE_ERROR_MESSAGES,
  type RetrievalToolDependencies,
} from './retrieval-core';
import type { RetrievalStore } from './retrieval-store';
import { resolveOptionalWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantHybridSearchTool');

export const HYBRID_SEARCH_TOOL_ID = NATIVE_TOOL_ID.hybridSearch;

const NO_NATIVE_INDEX_HYBRID_SEARCH =
  'Retrieval without a native index runs only on Main’s database.';
const DEFAULT_VECTOR_THRESHOLD = 0.5;
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

export async function runHybridSearchWith(
  input: HybridSearchInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  store: RetrievalStore,
  signal?: AbortSignal
): Promise<HybridSearchToolResult> {
  signal?.throwIfAborted();
  const query = input.query.trim();
  if (!query) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.invalidQuery);
  }
  const root = resolveOptionalWorkspaceRoot(runtimeData, input.root);
  const admittedRootIds = resolveAdmittedRetrievalRoots(
    dependencies.admittedWorkspaceRootIds,
    root?.rootId
  );
  const embeddingSetId = dependencies.nativeIndexSearch
    ? await resolveNativeAssistantCollection(
        dependencies.nativeIndexSearch,
        input.embeddingSetId,
        signal
      )
    : resolveHybridEmbeddingSetId(runtimeData, input.embeddingSetId);
  // Root resolution stays OUTSIDE the sanitizing catch: its errors are locally
  // constructed, user-actionable messages ("Open folders: ...") the model needs.

  try {
    signal?.throwIfAborted();
    const embeddingSet = await store.embeddingSet(embeddingSetId);
    if (dependencies.nativeIndexSearch) {
      const started = performance.now();
      const native = await searchNativeAssistantChunks({
        ...input,
        admittedWorkspaceRootIds: admittedRootIds,
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
      const fileMap = await store.fileRecords(native.hits.map(({ hit }) => hit.fileId));
      assertAdmittedRetrievalFileRoots(
        fileMap,
        native.hits.map(({ hit }) => hit.fileId),
        admittedRootIds
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
          ...(native.hint || truncated
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
    // The agent host retrieves only through the native index.
    throw new Error(NO_NATIVE_INDEX_HYBRID_SEARCH);
  } catch (error) {
    if (dependencies.nativeIndexSearch && signal?.aborted && error instanceof AggregateError) {
      throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.searchFailed, { cause: error });
    }
    signal?.throwIfAborted();
    handleHybridSearchError(error);
  }
}
