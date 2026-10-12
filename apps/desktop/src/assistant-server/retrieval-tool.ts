import type {
  ContextPackerChunk,
  ContextPackerResult,
  PackedContextChunk,
  QueryEmbeddingSpaceInput,
  RetrievalContextInput,
  RetrievalUnavailableResult,
  RuntimeData,
} from '@brainstrike/agent';
import {
  ContextPacker,
  createWorkspaceIndexUnavailableResult,
  hasWorkspaceIndexRuntimeStatus,
  normalizeOptionalText,
  resolveWorkspaceIndexEmbeddingSetId,
} from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { ChunkSearchResult } from '@brainstrike/db';
import { FileChunkRepository, FileRecordRepository } from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  type HostedProviderType,
  hostedProviderRequiresApiKey,
  isHostedProvider,
  isLocalProviderType,
  parseProviderModelKey,
} from '@brainstrike/embeddings/provider-core';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import { type DesktopDatabase, getDatabase } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { createHostedProvider, resolveEmbeddingApiKey } from '../hosted-embeddings';
import { SecretReadError } from '../secrets';
import {
  resolveNativeAssistantCollection,
  searchNativeAssistantChunks,
} from './native-assistant-retrieval';
import { resolveOptionalWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantRetrievalTool');

/**
 * DB/provider/network errors here can embed request-derived content (bound
 * query params, provider API messages, request URLs) in `.message` — never log
 * it verbatim (mirrors `redactToolErrorForLog` in assistant-tools.ts).
 */
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

const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_TOKEN_BUDGET = 4000;
/**
 * Maximum file paths to pass inline in the tool payload before switching to
 * server-side snapshot storage. At the cap this is still small enough for the
 * assistant request, while larger selections move out of the model/tool call.
 */
const MAX_INLINE_FILE_PATHS = 500;
/**
 * Absolute snapshot cap for large curated selections. Snapshot ids keep the
 * tool call compact, but this still bounds retained server-side payload size.
 */
const MAX_SNAPSHOT_FILE_PATHS = 5000;
/** Snapshot time-to-live (ms). Expired snapshots are best-effort cleaned up. */
const SNAPSHOT_TTL_MS = 1000 * 60 * 60; // 1 hour
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ERROR_MESSAGES = {
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
  ERROR_MESSAGES.missingQueryEmbeddingSpace,
  ERROR_MESSAGES.invalidEmbeddingSet,
  ERROR_MESSAGES.embeddingSetLookupFailed,
  ERROR_MESSAGES.unsupportedProvider,
  ERROR_MESSAGES.localEmbeddingHostUnavailable,
  ERROR_MESSAGES.missingApiKey,
  ERROR_MESSAGES.invalidSelectionSnapshot,
  ERROR_MESSAGES.invalidSelectionFilePaths,
  ERROR_MESSAGES.selectionTooLarge,
  ERROR_MESSAGES.embeddingDimensionMismatch,
  ERROR_MESSAGES.embeddingFailed,
  ERROR_MESSAGES.missingSourceRange,
]);

export interface EmbeddingSetRow {
  dimensions: number;
  distance: string | null;
  modelId: string;
  modelKey: string;
}

export interface FileRecordRow {
  id: string;
  name: string;
  path: string;
  /** Owning workspace root id; null for legacy/unrooted files. */
  rootId: string | null;
  /** Owning workspace root display name; null when unrooted. */
  rootName: string | null;
  tokenCount: number | null;
}

interface RetrievalSelectionState {
  filePaths?: string[];
  selectionSnapshotId?: string;
}

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

type RetrievalToolExecutionResult = RetrievalToolResult | RetrievalUnavailableResult;

function normalizeFilePaths(filePaths: readonly string[] | undefined): string[] | undefined {
  if (!filePaths || filePaths.length === 0) {
    return;
  }
  const unique = new Set<string>();
  for (const raw of filePaths) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return unique.size > 0 ? Array.from(unique) : undefined;
}

function isValidUuid(value: string): boolean {
  return UUID_V4_REGEX.test(value);
}

function assertValidSelectionSnapshotId(selectionSnapshotId: string): void {
  if (!isValidUuid(selectionSnapshotId)) {
    throw new Error(ERROR_MESSAGES.invalidSelectionSnapshot);
  }
}

function assertValidSelectionFilePaths(filePaths: readonly string[]): void {
  if (filePaths.length === 0) {
    throw new Error(ERROR_MESSAGES.invalidSelectionFilePaths);
  }
  if (filePaths.length > MAX_SNAPSHOT_FILE_PATHS) {
    throw new Error(ERROR_MESSAGES.selectionTooLarge);
  }
  for (const path of filePaths) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error(ERROR_MESSAGES.invalidSelectionFilePaths);
    }
  }
}

interface QueryResult<T> {
  rows: T[];
}

export async function resolveEmbeddingSet(
  db: DesktopDatabase,
  embeddingSetId: string
): Promise<EmbeddingSetRow> {
  let result: QueryResult<EmbeddingSetRow>;
  try {
    result = (await db.query(
      `SELECT
        model_key AS "modelKey",
        model_id AS "modelId",
        dimensions,
        distance
       FROM embedding_sets
       WHERE id = $1
       LIMIT 1`,
      [embeddingSetId]
    )) as QueryResult<EmbeddingSetRow>;
  } catch (error) {
    logger.error('Failed to load embedding set metadata', {
      embeddingSetId,
      error: redactErrorForLog(error),
    });
    throw new Error(ERROR_MESSAGES.embeddingSetLookupFailed);
  }
  const row = result.rows[0];
  if (!(row?.modelKey && row.modelId && row.dimensions)) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  return row;
}

async function createSelectionSnapshot(
  db: DesktopDatabase,
  filePaths: readonly string[]
): Promise<string> {
  assertValidSelectionFilePaths(filePaths);
  // Best-effort cleanup to avoid blocking snapshot creation on purge failures.
  void db
    .query(
      `DELETE FROM selection_snapshots
       WHERE expires_at IS NOT NULL
         AND expires_at <= NOW()`
    )
    .catch(() => {});
  const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString();
  const snapshotResult = (await db.query(
    `INSERT INTO selection_snapshots (expires_at)
     VALUES ($1)
     RETURNING id`,
    [expiresAt]
  )) as QueryResult<{ id: string }>;
  const snapshotId = snapshotResult.rows[0]?.id;
  if (!snapshotId) {
    throw new Error(ERROR_MESSAGES.retrievalFailed);
  }
  assertValidSelectionSnapshotId(snapshotId);
  await db.query(
    `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
     SELECT $1, UNNEST($2::text[])`,
    [snapshotId, filePaths]
  );
  return snapshotId;
}

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

function resolveRuntimeEmbeddingSetId(
  runtime: RuntimeData | undefined,
  inputEmbeddingSetId: string | undefined
): string | undefined {
  return (
    normalizeOptionalText(inputEmbeddingSetId) ??
    normalizeOptionalText(runtime?.embeddingSetId) ??
    resolveWorkspaceIndexEmbeddingSetId(runtime)
  );
}

function resolveSelectionFilters(
  runtime: RuntimeData | undefined,
  inputFilePaths: readonly string[] | undefined,
  inputSnapshotId: string | undefined
): { filePaths?: string[]; snapshotId?: string } {
  const runtimeSnapshotId = normalizeOptionalText(runtime?.selectionSnapshotId);
  const snapshotId = runtimeSnapshotId ?? normalizeOptionalText(inputSnapshotId);
  const runtimePaths = normalizeFilePaths(runtime?.selectionFilePaths);
  const filePaths = runtimePaths ?? normalizeFilePaths(inputFilePaths);
  if (snapshotId) {
    return { snapshotId };
  }
  return filePaths ? { filePaths } : {};
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
  fileMap: Map<string, FileRecordRow>
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

interface RootLabel {
  rootId: string | null;
  rootName: string | null;
}

/**
 * Resolve each file's owning workspace root (id + display name) in one query.
 * Kept separate from `findByIds` (which loads the base record) so retrieved
 * chunks can be disambiguated across roots that share a relative path. LEFT
 * JOIN so legacy/unrooted files still resolve (root id/name null).
 */
async function loadRootLabels(
  db: DesktopDatabase,
  ids: readonly string[]
): Promise<Map<string, RootLabel>> {
  const result = (await db.query(
    `SELECT fr.id, fr.root_id AS "rootId", r.display_name AS "rootName"
       FROM file_records fr
       LEFT JOIN roots r ON r.id = fr.root_id
      WHERE fr.id = ANY($1::text[])`,
    [Array.from(ids)]
  )) as QueryResult<{ id: string; rootId: string | null; rootName: string | null }>;
  return new Map(
    result.rows.map((row) => [
      row.id,
      { rootId: row.rootId ?? null, rootName: row.rootName ?? null },
    ])
  );
}

export async function buildFileRecordMap(
  repository: FileRecordRepository,
  db: DesktopDatabase,
  ids: readonly string[]
): Promise<Map<string, FileRecordRow>> {
  const map = new Map<string, FileRecordRow>();
  if (ids.length === 0) {
    return map;
  }
  const uniqueIds = Array.from(new Set(ids));
  const records = await repository.findByIds(uniqueIds);
  const rootLabels = await loadRootLabels(db, uniqueIds);
  for (const record of records) {
    const label = rootLabels.get(record.id);
    map.set(record.id, {
      id: record.id,
      name: record.name,
      path: record.path,
      rootId: label?.rootId ?? null,
      rootName: label?.rootName ?? null,
      tokenCount: record.tokenCount ?? null,
    });
  }
  return map;
}

async function generateQueryEmbedding(
  provider: HostedProviderType,
  modelId: string,
  dimensions: number,
  query: string,
  signal?: AbortSignal
): Promise<number[]> {
  signal?.throwIfAborted();
  const apiKey = await resolveEmbeddingApiKey(provider);
  signal?.throwIfAborted();
  if (hostedProviderRequiresApiKey(provider) && !apiKey) {
    throw new Error(ERROR_MESSAGES.missingApiKey);
  }
  const hostedProvider = createHostedProvider(provider, modelId, dimensions, apiKey);
  const result = await hostedProvider.embed({
    modelId,
    text: query,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (!result.ok) {
    logger.warn('Embedding provider returned error', {
      error: redactErrorForLog(result.error),
      provider,
      stage: 'provider-request',
    });
    throw new Error(ERROR_MESSAGES.embeddingFailed);
  }
  return result.value.embedding;
}

function resolveProviderForSet(embeddingSet: EmbeddingSetRow): EmbeddingProviderType {
  const parsed = parseProviderModelKey(embeddingSet.modelKey);
  if (!parsed) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  return parsed.provider;
}

export async function generateQueryEmbeddingForSet(
  embeddingSet: EmbeddingSetRow,
  query: string,
  dependencies: RetrievalToolDependencies,
  signal?: AbortSignal
): Promise<number[]> {
  signal?.throwIfAborted();
  const provider = resolveProviderForSet(embeddingSet);
  const startedAt = performance.now();
  try {
    if (isHostedProvider(provider)) {
      return await generateQueryEmbedding(
        provider,
        embeddingSet.modelId,
        embeddingSet.dimensions,
        query,
        signal
      );
    }
    if (isLocalProviderType(provider)) {
      const embeddingHostManager = dependencies.embeddingHostManager;
      if (!embeddingHostManager) {
        throw new Error(ERROR_MESSAGES.localEmbeddingHostUnavailable);
      }
      const payload = {
        dimensions: embeddingSet.dimensions,
        modelId: embeddingSet.modelId,
        modelKey: embeddingSet.modelKey,
        query,
      };
      return await (signal
        ? embeddingHostManager.queryEmbedding(payload, { signal })
        : embeddingHostManager.queryEmbedding(payload));
    }
    throw new Error(ERROR_MESSAGES.unsupportedProvider);
  } catch (error) {
    const timedOut = error instanceof Error && /timed out/i.test(error.message);
    if (signal?.aborted || timedOut) {
      logger.warn('Query embedding interrupted', {
        aborted: signal?.aborted ?? false,
        elapsedMs: Math.round(performance.now() - startedAt),
        provider,
        stage: isLocalProviderType(provider) ? 'local-host' : 'hosted-provider',
        timedOut,
      });
    }
    throw error;
  }
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error(ERROR_MESSAGES.retrievalFailed);
  }
  return normalized;
}

export function assertEmbeddingDimensions(expected: number, actual: number): void {
  if (expected === actual) {
    return;
  }
  logger.warn('Embedding dimension mismatch', { actual, expected });
  throw new Error(ERROR_MESSAGES.embeddingDimensionMismatch);
}

async function resolveSelectionState(
  db: DesktopDatabase,
  runtimeData: RuntimeData | undefined,
  input: RetrievalContextInput
): Promise<RetrievalSelectionState> {
  const selection = resolveSelectionFilters(
    runtimeData,
    input.filePaths,
    input.selectionSnapshotId
  );
  let selectionSnapshotId = selection.snapshotId;
  let filePaths = selection.filePaths;

  if (selectionSnapshotId) {
    assertValidSelectionSnapshotId(selectionSnapshotId);
  }
  if (filePaths) {
    assertValidSelectionFilePaths(filePaths);
  }

  if (!selectionSnapshotId && filePaths && filePaths.length > MAX_INLINE_FILE_PATHS) {
    selectionSnapshotId = await createSelectionSnapshot(db, filePaths);
    filePaths = undefined;
  }

  const state: RetrievalSelectionState = {};
  if (filePaths) {
    state.filePaths = filePaths;
  }
  if (selectionSnapshotId) {
    state.selectionSnapshotId = selectionSnapshotId;
  }
  return state;
}

async function searchForChunks(
  db: DesktopDatabase,
  embedding: number[],
  embeddingSetId: string,
  input: RetrievalContextInput,
  selection: RetrievalSelectionState,
  rootId: string | undefined
): Promise<ChunkSearchResult[]> {
  const chunkRepository = new FileChunkRepository(db);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  return chunkRepository.searchSimilar(embedding, {
    embeddingSetId,
    limit,
    threshold,
    ...(selection.filePaths ? { filePaths: selection.filePaths } : {}),
    ...(selection.selectionSnapshotId
      ? { selectionSnapshotId: selection.selectionSnapshotId }
      : {}),
    ...(rootId === undefined ? {} : { rootId }),
  });
}

async function packRetrievedContext(
  db: DesktopDatabase,
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
  input: RetrievalContextInput
): Promise<{
  packed: ContextPackerResult;
  contextText: string;
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
}> {
  const recordRepository = new FileRecordRepository(db);
  const fileIds = Array.from(new Set(searchResults.map((result) => result.chunk.fileRecordId)));
  const fileMap = await buildFileRecordMap(recordRepository, db, fileIds);
  const { chunks: chunkInputs, skippedSourceRangeChunks } = toContextChunks(searchResults, fileMap);
  if (searchResults.length > 0 && skippedSourceRangeChunks.length === searchResults.length) {
    logger.warn('All retrieved chunks are missing source ranges', {
      skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    });
    throw new Error(ERROR_MESSAGES.missingSourceRange);
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
  dependencies: RetrievalToolDependencies = {},
  signal?: AbortSignal
): Promise<RetrievalToolExecutionResult> {
  signal?.throwIfAborted();
  const query = normalizeQuery(input.query);
  const embeddingSetId = dependencies.nativeIndexSearch
    ? await resolveNativeAssistantCollection(
        dependencies.nativeIndexSearch,
        input.embeddingSetId,
        signal
      )
    : resolveRuntimeEmbeddingSetId(runtimeData, input.embeddingSetId);
  if (!embeddingSetId) {
    const unavailable = createWorkspaceIndexUnavailableResult(runtimeData, query);
    if (unavailable) {
      return unavailable;
    }
    // Invariant, not a user surface (BST-1020 review): runQueryEmbeddingSpace
    // — the sole caller — admits a request only with an explicit set or
    // workspace-index runtime status, and createWorkspaceIndexUnavailableResult
    // returns non-null for exactly that status. Reaching here means the two
    // predicates diverged; the sanitizer genericizes this loudly.
    throw new Error(
      'Retrieval invariant violated: no embedding set and no workspace-index status.'
    );
  }

  const db = await getDatabase();
  signal?.throwIfAborted();
  const embeddingSet = await resolveEmbeddingSet(db, embeddingSetId);
  const rootId = resolveOptionalWorkspaceRoot(runtimeData, input.root)?.rootId;
  const native = dependencies.nativeIndexSearch
    ? await searchNativeAssistantChunks({
        ...input,
        capability: dependencies.nativeIndexSearch,
        embeddingHostManager: dependencies.embeddingHostManager,
        embeddingSet,
        embeddingSetId,
        mode: 'semantic',
        query,
        rootId,
        signal,
        threshold: input.threshold ?? DEFAULT_THRESHOLD,
      })
    : undefined;
  let selectionState: RetrievalSelectionState = {};
  let searchResults: Parameters<typeof packRetrievedContext>[1];
  if (native) {
    searchResults = native.hits.map(({ hit, similarity }, index) => {
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
    });
  } else {
    const embedding = await generateQueryEmbeddingForSet(embeddingSet, query, dependencies, signal);
    signal?.throwIfAborted();
    assertEmbeddingDimensions(embeddingSet.dimensions, embedding.length);
    selectionState = await resolveSelectionState(db, runtimeData, input);
    searchResults = await searchForChunks(
      db,
      embedding,
      embeddingSetId,
      input,
      selectionState,
      rootId
    );
  }
  const { packed, contextText, skippedSourceRangeChunks } = await packRetrievedContext(
    db,
    searchResults,
    runtimeData,
    input
  );
  await native?.assertCurrent();
  signal?.throwIfAborted();

  return {
    budget: packed.budget,
    chunkContentIncludedInContext: packed.chunks.length > 0,
    chunks: stripChunkContent(packed.chunks),
    context: contextText,
    embeddingSetId,
    limit: native?.limit ?? input.limit ?? DEFAULT_LIMIT,
    ...(native
      ? { truncated: native.truncated, ...(native.hint ? { hint: native.hint } : {}) }
      : {}),
    query,
    remainingTokens: packed.remainingTokens,
    skipped: packed.skipped + skippedSourceRangeChunks.length,
    skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    skippedSourceRangeChunks,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    totalTokens: packed.totalTokens,
    ...(selectionState.selectionSnapshotId
      ? { selectionSnapshotId: selectionState.selectionSnapshotId }
      : {}),
  };
}

function handleRetrievalError(error: unknown): never {
  if (error instanceof SecretReadError || error instanceof ToolInputError) {
    // Both are deliberately safe surfaces: SecretReadError is user-actionable
    // key repair guidance, and ToolInputError (e.g. workspace-root
    // resolution) is model-actionable input prose. Never genericize them.
    throw error;
  }
  const message = error instanceof Error ? error.message : ERROR_MESSAGES.retrievalFailed;
  if (RETRIEVAL_SAFE_ERROR_MESSAGES.has(message)) {
    throw new Error(message);
  }
  logger.error('Retrieval tool failed', { error: redactErrorForLog(error) });
  throw new Error(ERROR_MESSAGES.retrievalFailed);
}

export async function runQueryEmbeddingSpace(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {},
  signal?: AbortSignal
): Promise<RetrievalToolExecutionResult> {
  try {
    signal?.throwIfAborted();
    const hasExplicitEmbeddingSet = Boolean(normalizeOptionalText(input.embeddingSetId));
    if (
      !(
        dependencies.nativeIndexSearch ||
        hasExplicitEmbeddingSet ||
        hasWorkspaceIndexRuntimeStatus(runtimeData)
      )
    ) {
      throw new Error(ERROR_MESSAGES.missingQueryEmbeddingSpace);
    }
    const explicitRuntimeData = omitImplicitContextRuntimeData(runtimeData);
    return await runRetrieval(input, explicitRuntimeData, dependencies, signal);
  } catch (error) {
    if (dependencies.nativeIndexSearch && signal?.aborted && error instanceof AggregateError) {
      throw new Error(ERROR_MESSAGES.retrievalFailed, { cause: error });
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
