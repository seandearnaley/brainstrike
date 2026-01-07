import { ContextPacker, RetrievalContextInputSchema } from '@brainstrike/agent';
import { FileChunkRepository, FileRecordRepository } from '@brainstrike/db';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  type HostedProviderType,
  isHostedProvider,
  OpenAIEmbeddingProvider,
  parseProviderModelKey,
  resolveHostedProviderApiKey,
  VoyageEmbeddingProvider,
} from '@brainstrike/embeddings';
import { countTokensHeuristic, createLogger } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';
import { getSecretsService } from '../secrets';

type AgentModule = typeof import('@brainstrike/agent');
type ContextPackerChunk = AgentModule['ContextPackerChunk'];
type ContextPackerResult = AgentModule['ContextPackerResult'];
type PackedContextChunk = AgentModule['PackedContextChunk'];
type RetrievalContextInput = AgentModule['RetrievalContextInput'];
type RuntimeData = AgentModule['RuntimeData'];

const logger = createLogger('AssistantRetrievalTool');

const TOOL_ID = 'brainstrike.retrieveContext' as const;
const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_TOKEN_BUDGET = 4000;
const MAX_INLINE_FILE_PATHS = 500;
const SNAPSHOT_TTL_MS = 1000 * 60 * 60; // 1 hour

const ERROR_MESSAGES = {
  missingEmbeddingSet: 'Select an active embedding set to enable retrieval.',
  invalidEmbeddingSet: 'Active embedding set metadata is unavailable.',
  unsupportedProvider:
    'Local embedding models are not available in the assistant. Choose a hosted embedding set.',
  missingApiKey: 'No API key configured for the embedding provider.',
  embeddingFailed: 'Unable to generate query embeddings for retrieval.',
  retrievalFailed: 'Unable to retrieve context right now. Try again.',
} as const;

const SAFE_ERROR_MESSAGES = new Set<string>([
  ERROR_MESSAGES.missingEmbeddingSet,
  ERROR_MESSAGES.invalidEmbeddingSet,
  ERROR_MESSAGES.unsupportedProvider,
  ERROR_MESSAGES.missingApiKey,
]);

type EmbeddingSetRow = {
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: string | null;
};

type FileRecordRow = {
  id: string;
  name: string;
  path: string;
  tokenCount: number | null;
};

type RetrievalSelectionState = {
  filePaths?: string[];
  selectionSnapshotId?: string;
};

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

type ToolContext<TInput> = {
  context: TInput;
};

type RetrievalToolResult = {
  query: string;
  embeddingSetId: string;
  limit: number;
  threshold: number;
  selectionSnapshotId?: string;
  totalTokens: number;
  budget: number;
  remainingTokens: number;
  skipped: number;
  context: string;
  chunks: PackedContextChunk[];
};

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

type QueryResult<T> = { rows: T[] };

async function resolveEmbeddingSet(db: PGlite, embeddingSetId: string) {
  const result = (await db.query(
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
  apiKey: string
) {
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({ modelId, targetDimensions: dimensions, apiKey });
    case 'google':
      return new GoogleEmbeddingProvider({ modelId, outputDimensions: dimensions, apiKey });
    case 'cohere':
      return new CohereEmbeddingProvider({ modelId, inputType: 'search_query', apiKey });
    case 'voyage':
      return new VoyageEmbeddingProvider({ modelId, inputType: 'query', apiKey });
    default:
      throw new Error(ERROR_MESSAGES.unsupportedProvider);
  }
}

async function createSelectionSnapshot(db: PGlite, filePaths: readonly string[]): Promise<string> {
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
      const chunkLabel = chunk.chunkIndex !== undefined ? ` (chunk ${chunk.chunkIndex})` : '';
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
    return {
      id: result.chunk.id,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount ?? undefined,
      filePath: fileInfo?.path,
      fileName: fileInfo?.name,
      chunkIndex: result.chunk.chunkIndex,
      score: result.similarity,
      metadata: {
        fileRecordId: result.chunk.fileRecordId,
        embeddingSetId: result.chunk.embeddingSetId,
        chunkType: result.chunk.chunkType,
        rank: result.rank,
        fileTokenCount: fileInfo?.tokenCount ?? undefined,
      },
    } satisfies ContextPackerChunk;
  });
}

async function buildFileRecordMap(
  repository: FileRecordRepository,
  ids: readonly string[]
): Promise<Map<string, FileRecordRow>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const record = await repository.findById(id);
      return [id, record] as const;
    })
  );
  const map = new Map<string, FileRecordRow>();
  for (const [id, record] of entries) {
    if (record) {
      map.set(id, {
        id: record.id,
        name: record.name,
        path: record.path,
        tokenCount: record.tokenCount ?? null,
      });
    }
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
  if (!apiKey) {
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

function logEmbeddingDimensionMismatch(expected: number, actual: number): void {
  if (expected === actual) {
    return;
  }
  logger.warn('Embedding dimension mismatch', {
    expected,
    actual,
  });
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
) {
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

  const packer = new ContextPacker({
    budgetTokens: resolveTokenBudget(runtimeData, input.tokenBudget),
    maxChunks: input.maxChunks,
    estimateTokens: countTokensHeuristic,
  });
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
  logEmbeddingDimensionMismatch(embeddingSet.dimensions, embedding.length);

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
    chunks: packed.chunks,
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
