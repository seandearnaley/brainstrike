import type {
  ContextPackerChunk,
  ContextPackerResult,
  PackedContextChunk,
  QueryEmbeddingSpaceInput,
  RetrievalContextInput,
  RetrievalUnavailableResult,
  RuntimeData,
} from '@brainstrike/agent';
import { ContextPacker } from '@brainstrike/agent';
import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import {
  resolveAdmittedRetrievalRoots,
  resolveNativeAssistantCollection,
  searchNativeAssistantChunks,
} from './native-assistant-retrieval';
import type { FileRecordRow, RetrievalStore } from './retrieval-store';
import { resolveOptionalWorkspaceRoot } from './workspace-roots';

export type { EmbeddingSetRow, FileRecordRow } from './retrieval-store';

const logger = createLogger('AssistantRetrievalTool');

/**
 * DB/provider/network errors here can embed request-derived content (bound
 * query params, provider API messages, request URLs) in `.message` — never log
 * it verbatim (mirrors `redactToolErrorForLog` in assistant-tools.ts).
 */
export function redactRetrievalErrorForLog(error: unknown): {
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

const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_TOKEN_BUDGET = 4000;
/** Retrieval reads the native index only; the agent host has no other similarity path. */
const NO_NATIVE_INDEX_RETRIEVAL = 'Retrieval without a native index runs only on Main’s database.';

export const RETRIEVAL_ERROR_MESSAGES = {
  embeddingDimensionMismatch: 'Embedding dimensions do not match the active set.',
  embeddingFailed: 'Unable to generate query embeddings for retrieval.',
  embeddingSetLookupFailed: 'Unable to load embedding set metadata.',
  invalidEmbeddingSet: 'Active embedding set metadata is unavailable.',
  invalidSelectionFilePaths: 'Selection file paths are invalid.',
  invalidSelectionSnapshot: 'Selection snapshot reference is invalid.',
  localEmbeddingHostUnavailable: 'Local embedding query host is unavailable.',
  missingApiKey: 'No API key configured for the embedding provider.',
  missingQueryEmbeddingSpace: 'Select an embedding space before querying semantic context.',
  missingSourceRange:
    'Retrieved chunks are missing source line metadata. Rebuild the embedding space.',
  retrievalFailed: 'Unable to retrieve context right now. Try again.',
  selectionTooLarge: 'Selection exceeds retrieval limits.',
  unsupportedProvider: 'Embedding provider is not supported by assistant retrieval.',
} as const;

/** Exported for the hybrid search tool, which reuses the same embedding path. */
export const RETRIEVAL_SAFE_ERROR_MESSAGES = new Set<string>([
  RETRIEVAL_ERROR_MESSAGES.missingQueryEmbeddingSpace,
  RETRIEVAL_ERROR_MESSAGES.invalidEmbeddingSet,
  RETRIEVAL_ERROR_MESSAGES.embeddingSetLookupFailed,
  RETRIEVAL_ERROR_MESSAGES.unsupportedProvider,
  RETRIEVAL_ERROR_MESSAGES.localEmbeddingHostUnavailable,
  RETRIEVAL_ERROR_MESSAGES.missingApiKey,
  RETRIEVAL_ERROR_MESSAGES.invalidSelectionSnapshot,
  RETRIEVAL_ERROR_MESSAGES.invalidSelectionFilePaths,
  RETRIEVAL_ERROR_MESSAGES.selectionTooLarge,
  RETRIEVAL_ERROR_MESSAGES.embeddingDimensionMismatch,
  RETRIEVAL_ERROR_MESSAGES.embeddingFailed,
  RETRIEVAL_ERROR_MESSAGES.missingSourceRange,
]);

type RetrievalResultChunk = Omit<PackedContextChunk, 'content'>;

type QueryEmbeddingHost = Pick<EmbeddingHostManager, 'queryEmbedding'>;

interface SkippedSourceRangeChunk {
  chunkId: string;
  chunkIndex: number;
  fileRecordId: string;
}

interface ContextChunkConversionResult {
  chunks: ContextPackerChunk[];
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
}

export interface RetrievalToolDependencies {
  admittedWorkspaceRootIds?: readonly string[] | undefined;
  embeddingHostManager?: QueryEmbeddingHost | null | undefined;
  nativeIndexSearch?: IndexSearchCapability | undefined;
}

interface RetrievalToolResult {
  budget: number;
  chunkContentIncludedInContext: boolean;
  chunks: RetrievalResultChunk[];
  context: string;
  embeddingSetId: string;
  hint?: string;
  limit: number;
  query: string;
  remainingTokens: number;
  selectionSnapshotId?: string;
  skipped: number;
  skippedForMissingSourceRange: number;
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
  threshold: number;
  totalTokens: number;
  truncated?: boolean;
}

export type RetrievalToolExecutionResult = RetrievalToolResult | RetrievalUnavailableResult;

function formatContext(chunks: readonly PackedContextChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }
  return chunks
    .map((chunk, index) => {
      const rootName = chunk.metadata?.['rootName'];
      const path = chunk.filePath ?? chunk.fileName ?? 'Unknown file';
      // Prefix the path with its root so the model can tell apart same-named
      // files across multiple open folders.
      const location =
        typeof rootName === 'string' && rootName.length > 0 ? `[${rootName}] ${path}` : path;
      const lineSuffix = chunk.lineRange ? `:${chunk.lineRange.start}-${chunk.lineRange.end}` : '';
      const chunkLabel = chunk.chunkIndex === undefined ? '' : ` (chunk ${chunk.chunkIndex})`;
      return `Source ${index + 1}: ${location}${lineSuffix}${chunkLabel}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

function stripChunkContent(chunks: readonly PackedContextChunk[]): RetrievalResultChunk[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    rank: chunk.rank,
    tokenCount: chunk.tokenCount,
    ...(chunk.chunkIndex === undefined ? {} : { chunkIndex: chunk.chunkIndex }),
    ...(chunk.fileName === undefined ? {} : { fileName: chunk.fileName }),
    ...(chunk.filePath === undefined ? {} : { filePath: chunk.filePath }),
    ...(chunk.lineRange === undefined ? {} : { lineRange: chunk.lineRange }),
    ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata }),
    ...(chunk.offsets === undefined ? {} : { offsets: chunk.offsets }),
    ...(chunk.score === undefined ? {} : { score: chunk.score }),
  }));
}

function resolveTokenBudget(runtime: RuntimeData | undefined, override?: number): number {
  const runtimeBudget = runtime?.tokenBudget;
  const candidate = override ?? runtimeBudget ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TOKEN_BUDGET;
  }
  return Math.floor(candidate);
}

function toContextChunks(
  results: Array<{
    chunk: {
      id: string;
      content: string;
      tokenCount?: number;
      chunkIndex: number;
      chunkType?: string;
      endLine?: number;
      endOffset?: number;
      fileRecordId: string;
      embeddingSetId?: string;
      startLine?: number;
      startOffset?: number;
    };
    similarity: number;
    rank: number;
  }>,
  fileMap: ReadonlyMap<string, FileRecordRow>
): ContextChunkConversionResult {
  const chunks: ContextPackerChunk[] = [];
  const skippedSourceRangeChunks: SkippedSourceRangeChunk[] = [];
  for (const result of results) {
    if (
      result.chunk.startLine === undefined ||
      result.chunk.endLine === undefined ||
      result.chunk.startOffset === undefined ||
      result.chunk.endOffset === undefined
    ) {
      skippedSourceRangeChunks.push({
        chunkId: result.chunk.id,
        chunkIndex: result.chunk.chunkIndex,
        fileRecordId: result.chunk.fileRecordId,
      });
      continue;
    }
    const fileInfo = fileMap.get(result.chunk.fileRecordId);
    if (!fileInfo) {
      logger.warn('File record missing for retrieved chunk', {
        chunkId: result.chunk.id,
        fileRecordId: result.chunk.fileRecordId,
      });
    }
    const chunk: ContextPackerChunk = {
      chunkIndex: result.chunk.chunkIndex,
      content: result.chunk.content,
      endLine: result.chunk.endLine,
      endOffset: result.chunk.endOffset,
      id: result.chunk.id,
      metadata: {
        chunkType: result.chunk.chunkType,
        embeddingSetId: result.chunk.embeddingSetId,
        fileRecordId: result.chunk.fileRecordId,
        fileTokenCount: fileInfo?.tokenCount ?? undefined,
        rank: result.rank,
        rootId: fileInfo?.rootId ?? undefined,
        rootName: fileInfo?.rootName ?? undefined,
      },
      score: result.similarity,
      startLine: result.chunk.startLine,
      startOffset: result.chunk.startOffset,
      tokenCount: result.chunk.tokenCount ?? null,
    };
    if (fileInfo?.path !== undefined) {
      chunk.filePath = fileInfo.path;
    }
    if (fileInfo?.name !== undefined) {
      chunk.fileName = fileInfo.name;
    }
    chunks.push(chunk);
  }
  return { chunks, skippedSourceRangeChunks };
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed);
  }
  return normalized;
}

/** Check actual catalog file ownership before an admitted subset receives content. */
export function assertAdmittedRetrievalFileRoots(
  files: ReadonlyMap<string, FileRecordRow>,
  fileIds: readonly string[],
  admitted: readonly string[] | undefined
): void {
  if (
    admitted !== undefined &&
    fileIds.some((id) => {
      const rootId = files.get(id)?.rootId;
      return rootId === undefined || rootId === null || !admitted.includes(rootId);
    })
  ) {
    throw new ToolInputError('Retrieval returned a file outside its admitted workspace scope.');
  }
}

async function packRetrievedContext(
  store: RetrievalStore,
  searchResults: Array<{
    chunk: {
      id: string;
      content: string;
      tokenCount?: number;
      chunkIndex: number;
      chunkType?: string;
      fileRecordId: string;
      embeddingSetId?: string;
      startLine?: number;
      endLine?: number;
      startOffset?: number;
      endOffset?: number;
    };
    similarity: number;
    rank: number;
  }>,
  runtimeData: RuntimeData | undefined,
  input: RetrievalContextInput,
  admittedRootIds: readonly string[] | undefined
): Promise<{
  packed: ContextPackerResult;
  contextText: string;
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
}> {
  const fileIds = Array.from(new Set(searchResults.map((result) => result.chunk.fileRecordId)));
  const fileMap = await store.fileRecords(fileIds);
  assertAdmittedRetrievalFileRoots(fileMap, fileIds, admittedRootIds);
  const { chunks: chunkInputs, skippedSourceRangeChunks } = toContextChunks(searchResults, fileMap);
  if (searchResults.length > 0 && skippedSourceRangeChunks.length === searchResults.length) {
    logger.warn('All retrieved chunks are missing source ranges', {
      skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    });
    throw new Error(RETRIEVAL_ERROR_MESSAGES.missingSourceRange);
  }
  if (skippedSourceRangeChunks.length > 0) {
    logger.warn('Some retrieved chunks are missing source ranges', {
      retrievedChunks: searchResults.length,
      skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    });
  }

  const packerOptions = {
    budgetTokens: resolveTokenBudget(runtimeData, input.tokenBudget),
    estimateTokens: countTokensHeuristic,
    ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
  };
  const packer = new ContextPacker(packerOptions);
  const packed = packer.pack(chunkInputs);
  const contextText = formatContext(packed.chunks);

  return { contextText, packed, skippedSourceRangeChunks };
}

async function runRetrieval(
  input: RetrievalContextInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  nativeIndexSearch: IndexSearchCapability,
  store: RetrievalStore,
  signal?: AbortSignal
): Promise<RetrievalToolExecutionResult> {
  signal?.throwIfAborted();
  const query = normalizeQuery(input.query);
  const rootId = resolveOptionalWorkspaceRoot(runtimeData, input.root)?.rootId;
  const admittedRootIds = resolveAdmittedRetrievalRoots(
    dependencies.admittedWorkspaceRootIds,
    rootId
  );
  const embeddingSetId = await resolveNativeAssistantCollection(
    nativeIndexSearch,
    input.embeddingSetId,
    signal
  );
  signal?.throwIfAborted();
  const embeddingSet = await store.embeddingSet(embeddingSetId);
  const native = await searchNativeAssistantChunks({
    ...input,
    admittedWorkspaceRootIds: admittedRootIds,
    capability: nativeIndexSearch,
    embeddingHostManager: dependencies.embeddingHostManager,
    embeddingSet,
    embeddingSetId,
    mode: 'semantic',
    query,
    rootId,
    signal,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
  });
  const searchResults: Parameters<typeof packRetrievedContext>[1] = native.hits.map(
    ({ hit, similarity }, index) => {
      if (hit.chunkIndex === null || hit.tokenCount === null || similarity === undefined) {
        throw new ToolInputError('Native source chunk metadata is unavailable.');
      }
      return {
        chunk: {
          chunkIndex: hit.chunkIndex,
          ...(hit.chunkType === null ? {} : { chunkType: hit.chunkType }),
          content: hit.content,
          embeddingSetId,
          endLine: hit.endLine,
          ...(hit.endOffset === null ? {} : { endOffset: hit.endOffset }),
          fileRecordId: hit.fileId,
          id: hit.chunkId,
          startLine: hit.startLine,
          ...(hit.startOffset === null ? {} : { startOffset: hit.startOffset }),
          tokenCount: hit.tokenCount,
        },
        rank: index + 1,
        similarity,
      };
    }
  );
  const { packed, contextText, skippedSourceRangeChunks } = await packRetrievedContext(
    store,
    searchResults,
    runtimeData,
    input,
    admittedRootIds
  );
  await native.assertCurrent();
  signal?.throwIfAborted();

  return {
    budget: packed.budget,
    chunkContentIncludedInContext: packed.chunks.length > 0,
    chunks: stripChunkContent(packed.chunks),
    context: contextText,
    embeddingSetId,
    limit: native.limit,
    truncated: native.truncated,
    ...(native.hint ? { hint: native.hint } : {}),
    query,
    remainingTokens: packed.remainingTokens,
    skipped: packed.skipped + skippedSourceRangeChunks.length,
    skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    skippedSourceRangeChunks,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    totalTokens: packed.totalTokens,
  };
}

function handleRetrievalError(error: unknown): never {
  if (error instanceof SecretReadError || error instanceof ToolInputError) {
    // Both are deliberately safe surfaces: SecretReadError is user-actionable
    // key repair guidance, and ToolInputError (e.g. workspace-root
    // resolution) is model-actionable input prose. Never genericize them.
    throw error;
  }
  const message = error instanceof Error ? error.message : RETRIEVAL_ERROR_MESSAGES.retrievalFailed;
  if (RETRIEVAL_SAFE_ERROR_MESSAGES.has(message)) {
    throw new Error(message);
  }
  logger.error('Retrieval tool failed', { error: redactRetrievalErrorForLog(error) });
  throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed);
}

export async function runQueryEmbeddingSpaceWith(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  store: RetrievalStore,
  signal?: AbortSignal
): Promise<RetrievalToolExecutionResult> {
  try {
    signal?.throwIfAborted();
    const { nativeIndexSearch } = dependencies;
    if (!nativeIndexSearch) {
      // The agent host retrieves only through the native index.
      throw new Error(NO_NATIVE_INDEX_RETRIEVAL);
    }
    const explicitRuntimeData = omitImplicitContextRuntimeData(runtimeData);
    return await runRetrieval(
      input,
      explicitRuntimeData,
      dependencies,
      nativeIndexSearch,
      store,
      signal
    );
  } catch (error) {
    if (dependencies.nativeIndexSearch && signal?.aborted && error instanceof AggregateError) {
      throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed, { cause: error });
    }
    signal?.throwIfAborted();
    // BST-1020: this normalization previously lived ONLY in the deleted
    // tool factories, so the LIVE registry path surfaced raw unexpected
    // errors (workspace paths included) toward the model. The live entry now
    // owns it: safe messages and SecretReadError pass through; anything else
    // is redact-logged and replaced with the generic retrieval failure.
    handleRetrievalError(error);
  }
}

function omitImplicitContextRuntimeData(
  runtimeData: RuntimeData | undefined
): RuntimeData | undefined {
  if (!runtimeData) {
    return;
  }
  const {
    embeddingSetId: _embeddingSetId,
    selectionFilePaths: _selectionFilePaths,
    selectionSnapshotId: _selectionSnapshotId,
    tokenBudget: _tokenBudget,
    ...explicitRuntimeData
  } = runtimeData;
  return explicitRuntimeData;
}
