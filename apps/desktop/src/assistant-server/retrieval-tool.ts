import { randomUUID } from 'node:crypto';
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
  QueryEmbeddingSpaceInputSchema,
  RetrievalContextInputSchema,
  resolveWorkspaceIndexEmbeddingSetId,
} from '@brainstrike/agent';
import type {
  BrainstrikeDbExecutionClient,
  ChunkSearchOptions,
  ChunkSearchResult,
  EmbeddingSet,
  FileRecord,
} from '@brainstrike/db';
import {
  FileChunkRepository,
  FileRecordRepository,
  getBrainstrikeDbExecutionRuntime,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoFileRecordRepository,
} from '@brainstrike/db';
import {
  CohereEmbeddingProvider,
  type EmbeddingProviderType,
  GoogleEmbeddingProvider,
  type HostedProviderType,
  hostedProviderRequiresApiKey,
  isHostedProvider,
  isLocalProviderType,
  OpenAIEmbeddingProvider,
  parseProviderModelKey,
  resolveHostedProviderApiKey,
  VoyageEmbeddingProvider,
} from '@brainstrike/embeddings/provider-core';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { createLogger } from '@brainstrike/utils/logger';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase, getDatabaseRuntimeDiagnostics } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { getSecretsService } from '../secrets';
import { resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantRetrievalTool');

const TOOL_ID = 'brainstrike.retrieveContext' as const;
const QUERY_EMBEDDING_SPACE_TOOL_ID = 'brainstrike.queryEmbeddingSpace' as const;
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
  missingEmbeddingSet: 'Select an active embedding set to enable retrieval.',
  missingQueryEmbeddingSpace: 'Select an embedding space before querying semantic context.',
  invalidEmbeddingSet: 'Active embedding set metadata is unavailable.',
  embeddingSetLookupFailed: 'Unable to load embedding set metadata.',
  unsupportedProvider: 'Embedding provider is not supported by assistant retrieval.',
  localEmbeddingHostUnavailable: 'Local embedding query host is unavailable.',
  missingApiKey: 'No API key configured for the embedding provider.',
  invalidSelectionSnapshot: 'Selection snapshot reference is invalid.',
  invalidSelectionFilePaths: 'Selection file paths are invalid.',
  selectionTooLarge: 'Selection exceeds retrieval limits.',
  embeddingDimensionMismatch: 'Embedding dimensions do not match the active set.',
  embeddingFailed: 'Unable to generate query embeddings for retrieval.',
  missingSourceRange:
    'Retrieved chunks are missing source line metadata. Rebuild the embedding space.',
  tursoUnavailable:
    'brainstrike.queryEmbeddingSpace requires a ready Turso bootstrap report with search.vector32-functions passed.',
  retrievalFailed: 'Unable to retrieve context right now. Try again.',
} as const;

const TURSO_VECTOR_SEARCH_CHECK_ID = 'search.vector32-functions';

const SAFE_ERROR_MESSAGES = new Set<string>([
  ERROR_MESSAGES.missingEmbeddingSet,
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
  ERROR_MESSAGES.tursoUnavailable,
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

type MastraTools = NonNullable<RuntimeData['mastraTools']>;
type QueryEmbeddingHost = Pick<EmbeddingHostManager, 'queryEmbedding'>;
type PgliteRetrievalDatabase = PGlite;
type TursoRetrievalDatabase = BrainstrikeDbExecutionClient;
type RetrievalDatabase = PgliteRetrievalDatabase | TursoRetrievalDatabase;

interface ChunkSearchRepository {
  searchSimilar(
    embedding: number[],
    options: ChunkSearchOptions
  ): Promise<readonly ChunkSearchResult[]>;
}

interface FileRecordLookupRepository {
  findByIds(ids: readonly string[]): Promise<readonly FileRecord[]>;
}

interface RetrievalRepositories {
  readonly chunks: ChunkSearchRepository;
  readonly files: FileRecordLookupRepository;
}

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
}

function isTursoRetrievalDatabase(db: unknown): db is TursoRetrievalDatabase {
  return getBrainstrikeDbExecutionRuntime(db) === 'turso';
}

async function assertReadyTursoVectorBootstrap(): Promise<void> {
  const diagnostics = await getDatabaseRuntimeDiagnostics();
  const report = diagnostics.profileBootstrapReport;
  const vectorCheck = report?.checks.find((check) => check.id === TURSO_VECTOR_SEARCH_CHECK_ID);
  if (
    !report?.ready ||
    report.phase !== 'ready' ||
    report.runtime.engine !== 'turso' ||
    report.failure ||
    vectorCheck?.required !== true ||
    vectorCheck.status !== 'passed'
  ) {
    throw new Error(ERROR_MESSAGES.tursoUnavailable);
  }
}

interface ToolContext<TInput> {
  context: TInput;
}

interface RetrievalToolResult {
  budget: number;
  chunkContentIncludedInContext: boolean;
  chunks: RetrievalResultChunk[];
  context: string;
  embeddingSetId: string;
  limit: number;
  query: string;
  remainingTokens: number;
  selectionSnapshotId?: string;
  skipped: number;
  skippedForMissingSourceRange: number;
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
  threshold: number;
  totalTokens: number;
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

async function resolveTursoEmbeddingSet(
  db: TursoRetrievalDatabase,
  embeddingSetId: string
): Promise<EmbeddingSetRow> {
  let embeddingSet: EmbeddingSet | null;
  try {
    embeddingSet = await new TursoEmbeddingSetsRepository(db).getById(embeddingSetId);
  } catch (error) {
    logger.error('Failed to load Turso embedding set metadata', { embeddingSetId, error });
    throw new Error(ERROR_MESSAGES.embeddingSetLookupFailed);
  }
  if (!(embeddingSet?.modelKey && embeddingSet.modelId && embeddingSet.dimensions)) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  return {
    dimensions: embeddingSet.dimensions,
    distance: embeddingSet.distance,
    modelId: embeddingSet.modelId,
    modelKey: embeddingSet.modelKey,
  };
}

async function resolveEmbeddingApiKey(provider: HostedProviderType): Promise<string | undefined> {
  const secrets = getSecretsService();
  const fromSecrets = await secrets.getKey(provider);
  const normalized = normalizeOptionalText(fromSecrets ?? undefined);
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
        ...(apiKey ? { apiKey } : {}),
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

async function createSelectionSnapshot(
  db: RetrievalDatabase,
  filePaths: readonly string[],
  runtime: 'pglite' | 'turso'
): Promise<string> {
  assertValidSelectionFilePaths(filePaths);
  if (runtime === 'turso') {
    return createTursoSelectionSnapshot(db as TursoRetrievalDatabase, filePaths);
  }
  const pgliteDb = db as PGlite;
  // Best-effort cleanup to avoid blocking snapshot creation on purge failures.
  void pgliteDb
    .query(
      `DELETE FROM selection_snapshots
       WHERE expires_at IS NOT NULL
         AND expires_at <= NOW()`
    )
    .catch(() => {});
  const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString();
  const snapshotResult = (await pgliteDb.query(
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
  await pgliteDb.query(
    `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
     SELECT $1, UNNEST($2::text[])`,
    [snapshotId, filePaths]
  );
  return snapshotId;
}

async function createTursoSelectionSnapshot(
  db: TursoRetrievalDatabase,
  filePaths: readonly string[]
): Promise<string> {
  const snapshotId = randomUUID();
  const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString();
  await db.transaction(async (tx) => {
    await tx.exec(
      `DELETE FROM selection_snapshots
       WHERE expires_at IS NOT NULL
         AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    );
    await tx.exec('INSERT INTO selection_snapshots (id, expires_at) VALUES (?, ?)', [
      snapshotId,
      expiresAt,
    ]);
    const batchSize = 250;
    for (let offset = 0; offset < filePaths.length; offset += batchSize) {
      const batch = filePaths.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => '(?, ?)').join(', ');
      await tx.exec(
        `INSERT OR IGNORE INTO selection_snapshot_files (snapshot_id, file_path)
         VALUES ${placeholders}`,
        batch.flatMap((filePath) => [snapshotId, filePath])
      );
    }
  });
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
      id: result.chunk.id,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount ?? null,
      chunkIndex: result.chunk.chunkIndex,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      startOffset: result.chunk.startOffset,
      endOffset: result.chunk.endOffset,
      score: result.similarity,
      metadata: {
        fileRecordId: result.chunk.fileRecordId,
        embeddingSetId: result.chunk.embeddingSetId,
        chunkType: result.chunk.chunkType,
        rank: result.rank,
        fileTokenCount: fileInfo?.tokenCount ?? undefined,
        rootId: fileInfo?.rootId ?? undefined,
        rootName: fileInfo?.rootName ?? undefined,
      },
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
async function loadRootLabels(db: PGlite, ids: readonly string[]): Promise<Map<string, RootLabel>> {
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

async function loadTursoRootLabels(
  db: TursoRetrievalDatabase,
  ids: readonly string[]
): Promise<Map<string, RootLabel>> {
  if (ids.length === 0) {
    return new Map();
  }
  const result = await db.query<{
    id: string;
    rootId: string | null;
    rootName: string | null;
  }>(
    `SELECT fr.id, fr.root_id AS rootId, r.display_name AS rootName
       FROM file_records fr
       LEFT JOIN roots r ON r.id = fr.root_id
      WHERE fr.id IN (${ids.map(() => '?').join(', ')})`,
    Array.from(ids)
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      { rootId: row.rootId ?? null, rootName: row.rootName ?? null },
    ])
  );
}

async function buildFileRecordMap(
  repository: FileRecordLookupRepository,
  db: RetrievalDatabase,
  ids: readonly string[],
  runtime: 'pglite' | 'turso'
): Promise<Map<string, FileRecordRow>> {
  const map = new Map<string, FileRecordRow>();
  if (ids.length === 0) {
    return map;
  }
  const uniqueIds = Array.from(new Set(ids));
  const records = await repository.findByIds(uniqueIds);
  const rootLabels =
    runtime === 'turso'
      ? await loadTursoRootLabels(db as TursoRetrievalDatabase, uniqueIds)
      : await loadRootLabels(db as PGlite, uniqueIds);
  for (const record of records) {
    const label = rootLabels.get(record.id);
    map.set(record.id, {
      id: record.id,
      name: record.name,
      path: record.path,
      tokenCount: record.tokenCount ?? null,
      rootId: label?.rootId ?? null,
      rootName: label?.rootName ?? null,
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

function resolveProviderForSet(embeddingSet: EmbeddingSetRow): EmbeddingProviderType {
  const parsed = parseProviderModelKey(embeddingSet.modelKey);
  if (!parsed) {
    throw new Error(ERROR_MESSAGES.invalidEmbeddingSet);
  }
  return parsed.provider;
}

async function generateQueryEmbeddingForSet(
  embeddingSet: EmbeddingSetRow,
  query: string,
  dependencies: RetrievalToolDependencies
): Promise<number[]> {
  const provider = resolveProviderForSet(embeddingSet);
  if (isHostedProvider(provider)) {
    return generateQueryEmbedding(provider, embeddingSet.modelId, embeddingSet.dimensions, query);
  }
  if (isLocalProviderType(provider)) {
    const embeddingHostManager = dependencies.embeddingHostManager;
    if (!embeddingHostManager) {
      throw new Error(ERROR_MESSAGES.localEmbeddingHostUnavailable);
    }
    return embeddingHostManager.queryEmbedding({
      dimensions: embeddingSet.dimensions,
      modelId: embeddingSet.modelId,
      modelKey: embeddingSet.modelKey,
      query,
    });
  }
  throw new Error(ERROR_MESSAGES.unsupportedProvider);
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
  db: RetrievalDatabase,
  runtime: 'pglite' | 'turso',
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
    selectionSnapshotId = await createSelectionSnapshot(db, filePaths, runtime);
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
  repository: ChunkSearchRepository,
  embedding: number[],
  embeddingSetId: string,
  input: RetrievalContextInput,
  selection: RetrievalSelectionState,
  rootId: string | undefined
): Promise<ChunkSearchResult[]> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  return Array.from(
    await repository.searchSimilar(embedding, {
      limit,
      threshold,
      embeddingSetId,
      ...(selection.filePaths ? { filePaths: selection.filePaths } : {}),
      ...(selection.selectionSnapshotId
        ? { selectionSnapshotId: selection.selectionSnapshotId }
        : {}),
      ...(rootId === undefined ? {} : { rootId }),
    })
  );
}

async function packRetrievedContext(
  db: RetrievalDatabase,
  repositories: RetrievalRepositories,
  runtime: 'pglite' | 'turso',
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
): Promise<{
  packed: ContextPackerResult;
  contextText: string;
  skippedSourceRangeChunks: SkippedSourceRangeChunk[];
}> {
  const fileIds = Array.from(new Set(searchResults.map((result) => result.chunk.fileRecordId)));
  const fileMap = await buildFileRecordMap(repositories.files, db, fileIds, runtime);
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

  return { packed, contextText, skippedSourceRangeChunks };
}

function createRetrievalRepositories(
  db: RetrievalDatabase,
  runtime: 'pglite' | 'turso'
): RetrievalRepositories {
  if (runtime === 'turso') {
    const executionDb = db as TursoRetrievalDatabase;
    return {
      chunks: new TursoFileChunkRepository(executionDb),
      files: new TursoFileRecordRepository(executionDb),
    };
  }
  const pgliteDb = db as PGlite;
  return {
    chunks: new FileChunkRepository(pgliteDb),
    files: new FileRecordRepository(pgliteDb),
  };
}

async function runRetrieval(
  input: RetrievalContextInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {}
): Promise<RetrievalToolExecutionResult> {
  const query = normalizeQuery(input.query);
  const embeddingSetId = resolveRuntimeEmbeddingSetId(runtimeData, input.embeddingSetId);
  if (!embeddingSetId) {
    const unavailable = createWorkspaceIndexUnavailableResult(runtimeData, query);
    if (unavailable) {
      return unavailable;
    }
    throw new Error(ERROR_MESSAGES.missingEmbeddingSet);
  }

  const db = await getDatabase();
  const runtime = isTursoRetrievalDatabase(db) ? 'turso' : 'pglite';
  if (runtime === 'turso') {
    await assertReadyTursoVectorBootstrap();
  }
  const repositories = createRetrievalRepositories(db as RetrievalDatabase, runtime);
  const embeddingSet =
    runtime === 'turso'
      ? await resolveTursoEmbeddingSet(db as TursoRetrievalDatabase, embeddingSetId)
      : await resolveEmbeddingSet(db as PGlite, embeddingSetId);
  const embedding = await generateQueryEmbeddingForSet(embeddingSet, query, dependencies);
  assertEmbeddingDimensions(embeddingSet.dimensions, embedding.length);

  const selectionState = await resolveSelectionState(
    db as RetrievalDatabase,
    runtime,
    runtimeData,
    input
  );
  // An explicit `root` scopes retrieval to one open folder; resolving throws a
  // clear "Open folders: ..." error for an unknown/ambiguous name. Omitting it
  // searches every root (results stay labelled with their owning root).
  const rootId =
    input.root === undefined ? undefined : resolveWorkspaceRoot(runtimeData, input.root).rootId;
  const searchResults = await searchForChunks(
    repositories.chunks,
    embedding,
    embeddingSetId,
    input,
    selectionState,
    rootId
  );
  const { packed, contextText, skippedSourceRangeChunks } = await packRetrievedContext(
    db as RetrievalDatabase,
    repositories,
    runtime,
    searchResults,
    runtimeData,
    input
  );

  return {
    query,
    embeddingSetId,
    limit: input.limit ?? DEFAULT_LIMIT,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    totalTokens: packed.totalTokens,
    budget: packed.budget,
    remainingTokens: packed.remainingTokens,
    skipped: packed.skipped + skippedSourceRangeChunks.length,
    context: contextText,
    chunkContentIncludedInContext: packed.chunks.length > 0,
    chunks: stripChunkContent(packed.chunks),
    skippedForMissingSourceRange: skippedSourceRangeChunks.length,
    skippedSourceRangeChunks,
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

export function createRetrievalTool(
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {}
): MastraTools[string] {
  return {
    id: TOOL_ID,
    description:
      'Retrieve and pack relevant project context from the active embedding set. Use for codebase questions.',
    inputSchema: RetrievalContextInputSchema,
    execute: async (context: ToolContext<RetrievalContextInput>) => {
      try {
        return await runRetrieval(context.context, runtimeData, dependencies);
      } catch (error) {
        handleRetrievalError(error);
      }
    },
  };
}

export async function runQueryEmbeddingSpace(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {}
): Promise<RetrievalToolExecutionResult> {
  const hasExplicitEmbeddingSet = Boolean(normalizeOptionalText(input.embeddingSetId));
  if (!(hasExplicitEmbeddingSet || hasWorkspaceIndexRuntimeStatus(runtimeData))) {
    throw new Error(ERROR_MESSAGES.missingQueryEmbeddingSpace);
  }
  const explicitRuntimeData = omitImplicitContextRuntimeData(runtimeData);
  return await runRetrieval(input, explicitRuntimeData, dependencies);
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

export function createQueryEmbeddingSpaceTool(
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {}
): MastraTools[string] {
  return {
    id: QUERY_EMBEDDING_SPACE_TOOL_ID,
    description:
      'Query semantic workspace context. Omit embeddingSetId for Workspace Index codebase searches; provide embeddingSetId only for a specific non-default embedding space. Provide tokenBudget, limit, threshold, and optional filePaths to keep retrieval bounded.',
    inputSchema: QueryEmbeddingSpaceInputSchema,
    execute: async (context: ToolContext<QueryEmbeddingSpaceInput>) => {
      const input = QueryEmbeddingSpaceInputSchema.parse(context.context);
      try {
        return await runQueryEmbeddingSpace(input, runtimeData, dependencies);
      } catch (error) {
        handleRetrievalError(error);
      }
    },
  };
}

export function buildAssistantTools(
  runtimeData: RuntimeData | undefined,
  base: MastraTools,
  dependencies: RetrievalToolDependencies = {}
): MastraTools {
  return {
    ...base,
    [TOOL_ID]: createRetrievalTool(runtimeData, dependencies),
  };
}
