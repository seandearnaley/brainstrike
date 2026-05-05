import type {
  ContextPackerChunk,
  ContextPackerResult,
  PackedContextChunk,
  RetrievalContextInput,
  RuntimeData,
} from '@brainstrike/agent';
import { ContextPacker, RetrievalContextInputSchema } from '@brainstrike/agent';
import type { ChunkSearchResult } from '@brainstrike/db';
import { FileChunkRepository, FileRecordRepository } from '@brainstrike/db';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  type HostedProviderType,
  hostedProviderRequiresApiKey,
  isHostedProvider,
  OpenAIEmbeddingProvider,
  parseProviderModelKey,
  resolveHostedProviderApiKey,
  VoyageEmbeddingProvider,
} from '@brainstrike/embeddings/provider-core';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { createLogger } from '@brainstrike/utils/logger';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';
import { getSecretsService } from '../secrets';

const logger = createLogger('AssistantRetrievalTool');

const TOOL_ID = 'brainstrike.retrieveContext' as const;
const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_TOKEN_BUDGET = 4000;
/** Maximum file paths to pass inline before switching to snapshot storage. */
const MAX_INLINE_FILE_PATHS = 500;
/** Absolute cap on file paths to prevent oversized snapshot payloads. */
const MAX_SNAPSHOT_FILE_PATHS = 5000;
/** Snapshot time-to-live (ms). Expired snapshots are best-effort cleaned up. */
const SNAPSHOT_TTL_MS = 1000 * 60 * 60; // 1 hour
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ERROR_MESSAGES = {
  missingEmbeddingSet: 'Select an active embedding set to enable retrieval.',
  invalidEmbeddingSet: 'Active embedding set metadata is unavailable.',
  embeddingSetLookupFailed: 'Unable to load embedding set metadata.',
  unsupportedProvider:
    'Local embedding models are not available in the assistant. Choose a hosted embedding set.',
  missingApiKey: 'No API key configured for the embedding provider.',
  invalidSelectionSnapshot: 'Selection snapshot reference is invalid.',
  invalidSelectionFilePaths: 'Selection file paths are invalid.',
  selectionTooLarge: 'Selection exceeds retrieval limits.',
  embeddingDimensionMismatch: 'Embedding dimensions do not match the active set.',
  embeddingFailed: 'Unable to generate query embeddings for retrieval.',
  retrievalFailed: 'Unable to retrieve context right now. Try again.',
} as const;

const SAFE_ERROR_MESSAGES = new Set<string>([
  ERROR_MESSAGES.missingEmbeddingSet,
  ERROR_MESSAGES.invalidEmbeddingSet,
  ERROR_MESSAGES.embeddingSetLookupFailed,
  ERROR_MESSAGES.unsupportedProvider,
  ERROR_MESSAGES.missingApiKey,
  ERROR_MESSAGES.invalidSelectionSnapshot,
  ERROR_MESSAGES.invalidSelectionFilePaths,
  ERROR_MESSAGES.selectionTooLarge,
  ERROR_MESSAGES.embeddingDimensionMismatch,
]);

interface EmbeddingSetRow {
  dimensions: number;
  distance: string | null;
  modelId: string;
  modelKey: string;
}

type HostedEmbeddingProvider =
  | OpenAIEmbeddingProvider
  | GoogleEmbeddingProvider
  | CohereEmbeddingProvider
  | VoyageEmbeddingProvider;

interface FileRecordRow {
  id: string;
  name: string;
  path: string;
  tokenCount: number | null;
}

interface RetrievalSelectionState {
  filePaths?: string[];
  selectionSnapshotId?: string;
}

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

interface ToolContext<TInput> {
  context: TInput;
}

interface RetrievalToolResult {
  budget: number;
  chunks: PackedContextChunk[];
  context: string;
  embeddingSetId: string;
  limit: number;
  query: string;
  remainingTokens: number;
  selectionSnapshotId?: string;
  skipped: number;
  threshold: number;
  totalTokens: number;
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

async function resolveEmbeddingSet(db: PGlite, embeddingSetId: string): Promise<EmbeddingSetRow> {
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
    logger.error('Failed to load embedding set metadata', { embeddingSetId, error });
    throw new Error(ERROR_MESSAGES.embeddingSetLookupFailed);
  }
  const row = result.rows[0];
  if (!(row?.modelKey && row.modelId && row.dimensions)) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  return row;
}

async function resolveEmbeddingApiKey(provider: HostedProviderType): Promise<string | undefined> {
  const secrets = getSecretsService();
  const fromSecrets = await secrets.getKey(provider);
  const normalized = normalizeText(fromSecrets ?? undefined);
  if (normalized) {
    return normalized;
  }
  return resolveHostedProviderApiKey(provider);
}

function createHostedProvider(
  provider: HostedProviderType,
  modelId: string,
  dimensions: number,
  apiKey?: string
): HostedEmbeddingProvider {
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        provider: 'openai',
        modelId,
        targetDimensions: dimensions,
        apiKey,
      });
    case 'ollama':
      return new OpenAIEmbeddingProvider({
        provider: 'ollama',
        modelId,
        targetDimensions: dimensions,
        endpoint: 'http://127.0.0.1:11434/v1/embeddings',
        ...(apiKey ? { apiKey } : {}),
        requiresApiKey: false,
        includeDimensions: false,
      });
    case 'lmstudio':
      return new OpenAIEmbeddingProvider({
        provider: 'lmstudio',
        modelId,
        targetDimensions: dimensions,
        endpoint: 'http://localhost:1234/v1/embeddings',
        ...(apiKey ? { apiKey } : {}),
        requiresApiKey: false,
        includeDimensions: false,
      });
    case 'google':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new GoogleEmbeddingProvider({ modelId, outputDimensions: dimensions, apiKey });
    case 'cohere':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new CohereEmbeddingProvider({ modelId, inputType: 'search_query', apiKey });
    case 'voyage':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new VoyageEmbeddingProvider({ modelId, inputType: 'query', apiKey });
    default:
      throw new Error(ERROR_MESSAGES.unsupportedProvider);
  }
}

async function createSelectionSnapshot(db: PGlite, filePaths: readonly string[]): Promise<string> {
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
      const location = chunk.filePath ?? chunk.fileName ?? 'Unknown file';
      const chunkLabel = chunk.chunkIndex === undefined ? '' : ` (chunk ${chunk.chunkIndex})`;
      return `Source ${index + 1}: ${location}${chunkLabel}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

function resolveRuntimeEmbeddingSetId(
  runtime: RuntimeData | undefined,
  inputEmbeddingSetId: string | undefined
): string | undefined {
  return normalizeText(runtime?.embeddingSetId) ?? normalizeText(inputEmbeddingSetId);
}

function resolveSelectionFilters(
  runtime: RuntimeData | undefined,
  inputFilePaths: readonly string[] | undefined,
  inputSnapshotId: string | undefined
): { filePaths?: string[]; snapshotId?: string } {
  const runtimeSnapshotId = normalizeText(runtime?.selectionSnapshotId);
  const snapshotId = runtimeSnapshotId ?? normalizeText(inputSnapshotId);
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
      fileRecordId: string;
      embeddingSetId?: string;
    };
    similarity: number;
    rank: number;
  }>,
  fileMap: Map<string, FileRecordRow>
): ContextPackerChunk[] {
  return results.map((result) => {
    const fileInfo = fileMap.get(result.chunk.fileRecordId);
    if (!fileInfo) {
      logger.warn('File record missing for retrieved chunk', {
        chunkId: result.chunk.id,
        fileRecordId: result.chunk.fileRecordId,
      });
    }
    const chunk: ContextPackerChunk = {
      id: result.chunk.id,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount ?? null,
      chunkIndex: result.chunk.chunkIndex,
      score: result.similarity,
      metadata: {
        fileRecordId: result.chunk.fileRecordId,
        embeddingSetId: result.chunk.embeddingSetId,
        chunkType: result.chunk.chunkType,
        rank: result.rank,
        fileTokenCount: fileInfo?.tokenCount ?? undefined,
      },
    };
    if (fileInfo?.path !== undefined) {
      chunk.filePath = fileInfo.path;
    }
    if (fileInfo?.name !== undefined) {
      chunk.fileName = fileInfo.name;
    }
    return chunk;
  });
}

async function buildFileRecordMap(
  repository: FileRecordRepository,
  ids: readonly string[]
): Promise<Map<string, FileRecordRow>> {
  const map = new Map<string, FileRecordRow>();
  if (ids.length === 0) {
    return map;
  }
  const uniqueIds = Array.from(new Set(ids));
  const records = await repository.findByIds(uniqueIds);
  for (const record of records) {
    map.set(record.id, {
      id: record.id,
      name: record.name,
      path: record.path,
      tokenCount: record.tokenCount ?? null,
    });
  }
  return map;
}

async function generateQueryEmbedding(
  provider: HostedProviderType,
  modelId: string,
  dimensions: number,
  query: string
): Promise<number[]> {
  const apiKey = await resolveEmbeddingApiKey(provider);
  if (hostedProviderRequiresApiKey(provider) && !apiKey) {
    throw new Error(ERROR_MESSAGES.missingApiKey);
  }
  const hostedProvider = createHostedProvider(provider, modelId, dimensions, apiKey);
  const result = await hostedProvider.embed({ text: query, modelId });
  if (!result.ok) {
    logger.warn('Embedding provider returned error', { provider, error: result.error });
    throw new Error(ERROR_MESSAGES.embeddingFailed);
  }
  return result.value.embedding;
}

function resolveHostedProviderForSet(embeddingSet: EmbeddingSetRow): HostedProviderType {
  const parsed = parseProviderModelKey(embeddingSet.modelKey);
  if (!parsed) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  if (!isHostedProvider(parsed.provider)) {
    throw new Error(ERROR_MESSAGES.unsupportedProvider);
  }
  return parsed.provider as HostedProviderType;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error(ERROR_MESSAGES.retrievalFailed);
  }
  return normalized;
}

function assertEmbeddingDimensions(expected: number, actual: number): void {
  if (expected === actual) {
    return;
  }
  logger.warn('Embedding dimension mismatch', { expected, actual });
  throw new Error(ERROR_MESSAGES.embeddingDimensionMismatch);
}

async function resolveSelectionState(
  db: PGlite,
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
  db: PGlite,
  embedding: number[],
  embeddingSetId: string,
  input: RetrievalContextInput,
  selection: RetrievalSelectionState
): Promise<ChunkSearchResult[]> {
  const chunkRepository = new FileChunkRepository(db);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  return chunkRepository.searchSimilar(embedding, {
    limit,
    threshold,
    embeddingSetId,
    ...(selection.filePaths ? { filePaths: selection.filePaths } : {}),
    ...(selection.selectionSnapshotId
      ? { selectionSnapshotId: selection.selectionSnapshotId }
      : {}),
  });
}

async function packRetrievedContext(
  db: PGlite,
  searchResults: Array<{
    chunk: {
      id: string;
      content: string;
      tokenCount?: number;
      chunkIndex: number;
      chunkType?: string;
      fileRecordId: string;
      embeddingSetId?: string;
    };
    similarity: number;
    rank: number;
  }>,
  runtimeData: RuntimeData | undefined,
  input: RetrievalContextInput
): Promise<{ packed: ContextPackerResult; contextText: string }> {
  const recordRepository = new FileRecordRepository(db);
  const fileIds = Array.from(new Set(searchResults.map((result) => result.chunk.fileRecordId)));
  const fileMap = await buildFileRecordMap(recordRepository, fileIds);
  const chunkInputs = toContextChunks(searchResults, fileMap);

  const packerOptions = {
    budgetTokens: resolveTokenBudget(runtimeData, input.tokenBudget),
    estimateTokens: countTokensHeuristic,
    ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
  };
  const packer = new ContextPacker(packerOptions);
  const packed = packer.pack(chunkInputs);
  const contextText = formatContext(packed.chunks);

  return { packed, contextText };
}

async function runRetrieval(
  input: RetrievalContextInput,
  runtimeData: RuntimeData | undefined
): Promise<RetrievalToolResult> {
  const query = normalizeQuery(input.query);
  const embeddingSetId = resolveRuntimeEmbeddingSetId(runtimeData, input.embeddingSetId);
  if (!embeddingSetId) {
    throw new Error(ERROR_MESSAGES.missingEmbeddingSet);
  }

  const db = (await getDatabase()) as unknown as PGlite;
  const embeddingSet = await resolveEmbeddingSet(db, embeddingSetId);
  const provider = resolveHostedProviderForSet(embeddingSet);
  const embedding = await generateQueryEmbedding(
    provider,
    embeddingSet.modelId,
    embeddingSet.dimensions,
    query
  );
  assertEmbeddingDimensions(embeddingSet.dimensions, embedding.length);

  const selectionState = await resolveSelectionState(db, runtimeData, input);
  const searchResults = await searchForChunks(db, embedding, embeddingSetId, input, selectionState);
  const { packed, contextText } = await packRetrievedContext(db, searchResults, runtimeData, input);

  return {
    query,
    embeddingSetId,
    limit: input.limit ?? DEFAULT_LIMIT,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    totalTokens: packed.totalTokens,
    budget: packed.budget,
    remainingTokens: packed.remainingTokens,
    skipped: packed.skipped,
    context: contextText,
    chunks: [...packed.chunks],
    ...(selectionState.selectionSnapshotId
      ? { selectionSnapshotId: selectionState.selectionSnapshotId }
      : {}),
  };
}

function handleRetrievalError(error: unknown): never {
  const message = error instanceof Error ? error.message : ERROR_MESSAGES.retrievalFailed;
  if (SAFE_ERROR_MESSAGES.has(message)) {
    throw new Error(message);
  }
  logger.error('Retrieval tool failed', { error });
  if (process.env['NODE_ENV'] === 'development') {
    const debugMessage =
      error instanceof Error ? (error.stack ?? error.message) : String(error ?? 'Unknown error');
    throw new Error(`${ERROR_MESSAGES.retrievalFailed} [Debug: ${debugMessage}]`);
  }
  throw new Error(ERROR_MESSAGES.retrievalFailed);
}

export function createRetrievalTool(runtimeData: RuntimeData | undefined): MastraTools[string] {
  return {
    id: TOOL_ID,
    description:
      'Retrieve and pack relevant project context from the active embedding set. Use for codebase questions.',
    inputSchema: RetrievalContextInputSchema,
    execute: async (context: ToolContext<RetrievalContextInput>) => {
      try {
        return await runRetrieval(context.context, runtimeData);
      } catch (error) {
        handleRetrievalError(error);
      }
    },
  };
}

export function buildAssistantTools(
  runtimeData: RuntimeData | undefined,
  base: MastraTools
): MastraTools {
  return {
    ...base,
    [TOOL_ID]: createRetrievalTool(runtimeData),
  };
}
