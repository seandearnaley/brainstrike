import type {
  DiagnosticsToolDependencies,
  EmbeddingSetsToolDependencies,
  FileEntry,
  FileTreeToolDependencies,
  HybridSearchServiceMetadata,
  HybridSearchServiceResult,
  HybridSearchToolDependencies,
  QueueStatusToolDependencies,
  VectorQueueSnapshot,
} from '@brainstrike/agent';
import {
  buildToolsWithDiagnostics,
  buildToolsWithEmbeddingSets,
  buildToolsWithFileTree,
  buildToolsWithHybridSearch,
  buildToolsWithQueueStatus,
  EMBEDDING_SETS_ERROR_MESSAGES,
  HYBRID_SEARCH_ERROR_MESSAGES,
  type RuntimeData,
} from '@brainstrike/agent';
import type { EmbeddingDistance, IDatabase } from '@brainstrike/db';
import {
  EmbeddingSetsRepository,
  FileChunkRepository,
  FileRecordRepository,
  HybridSearchService,
  JobQueue,
} from '@brainstrike/db';
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
import { createLogger, fileFilter } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';
import { getSecretsService } from '../secrets';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

const logger = createLogger('DesktopAssistantTools');

const EMBEDDINGS_QUEUE_NAME = 'embeddings';

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (trimmed === '/') {
    return '/';
  }
  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return withoutDotPrefix.replace(/\/+$/, '');
}

function joinPath(base: string, segment: string): string {
  if (!base) {
    return segment;
  }
  if (base === '/') {
    return `/${segment}`;
  }
  return `${base}/${segment}`;
}

function isHiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function getDirName(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  return parts.at(-1) ?? normalized;
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function queryRows<T>(db: PGlite, sql: string, params?: unknown[]): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

function createDbAdapter(db: PGlite): IDatabase {
  return {
    query: async <T = unknown>(sql: string, params?: unknown[]) => {
      const result = await db.query(sql, params ?? []);
      return { rows: result.rows as T[] };
    },
  };
}

interface EmbeddingSetsDb {
  exec: (sql: string, params?: unknown) => Promise<unknown>;
  query: <T = unknown>(sql: string, params?: unknown) => Promise<{ rows: T[] }>;
}

function createEmbeddingSetsDbAdapter(db: PGlite): EmbeddingSetsDb {
  return {
    exec: async (sql: string) => await db.exec(sql),
    query: async <T = unknown>(sql: string, params?: unknown) => {
      const parameters = Array.isArray(params) ? (params as unknown[]) : undefined;
      const result = await db.query(sql, parameters);
      return { rows: result.rows as T[] };
    },
  };
}

function createEmbeddingSetsRepository(db: PGlite): EmbeddingSetsRepository {
  return new EmbeddingSetsRepository(createEmbeddingSetsDbAdapter(db));
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

type HostedEmbeddingProvider =
  | OpenAIEmbeddingProvider
  | GoogleEmbeddingProvider
  | CohereEmbeddingProvider
  | VoyageEmbeddingProvider;

function resolveHostedProviderMetadata(
  provider: HostedProviderType,
  modelId: string
): { dimensions: number; distance: EmbeddingDistance } | null {
  try {
    switch (provider) {
      case 'openai': {
        const probe = new OpenAIEmbeddingProvider({ modelId, targetDimensions: 1 });
        const info = probe.getModelInfo(modelId);
        if (!info) {
          return null;
        }
        const configured = new OpenAIEmbeddingProvider({
          modelId,
          targetDimensions: info.dimensions,
        });
        const metadata = configured.getMetadata(modelId);
        return metadata ? { dimensions: metadata.dimensions, distance: metadata.distance } : null;
      }
      case 'google': {
        const providerInstance = new GoogleEmbeddingProvider({ modelId });
        const metadata = providerInstance.getMetadata(modelId);
        return metadata ? { dimensions: metadata.dimensions, distance: metadata.distance } : null;
      }
      case 'cohere': {
        const providerInstance = new CohereEmbeddingProvider({ modelId });
        const metadata = providerInstance.getMetadata(modelId);
        return metadata ? { dimensions: metadata.dimensions, distance: metadata.distance } : null;
      }
      case 'voyage': {
        const providerInstance = new VoyageEmbeddingProvider({ modelId });
        const metadata = providerInstance.getMetadata(modelId);
        return metadata ? { dimensions: metadata.dimensions, distance: metadata.distance } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function createHostedProvider(
  provider: HostedProviderType,
  modelId: string,
  dimensions: number,
  apiKey: string
): HostedEmbeddingProvider {
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
      throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.unsupportedProvider);
  }
}

async function generateHostedQueryEmbedding(
  db: PGlite,
  embeddingSetId: string,
  query: string
): Promise<{ embedding: number[]; embeddingSetDimensions: number; embeddingSetModelId: string }> {
  const embeddingSetsRepository = createEmbeddingSetsRepository(db);
  const embeddingSet = await embeddingSetsRepository.getById(embeddingSetId);
  if (!embeddingSet) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.embeddingSetNotFound);
  }

  const parsed = parseProviderModelKey(embeddingSet.modelKey);
  if (!(parsed && isHostedProvider(parsed.provider))) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.unsupportedProvider);
  }

  const apiKey = await resolveEmbeddingApiKey(parsed.provider);
  if (!apiKey) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.missingApiKey);
  }

  const provider = createHostedProvider(
    parsed.provider,
    embeddingSet.modelId,
    embeddingSet.dimensions,
    apiKey
  );

  const result = await provider.embed({ text: query, modelId: embeddingSet.modelId });
  if (!result.ok) {
    logger.warn('Embedding provider returned error', { provider: parsed.provider, error: result });
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.embeddingFailed);
  }

  const embedding = result.value.embedding;
  if (embedding.length !== embeddingSet.dimensions) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.embeddingFailed);
  }

  return {
    embedding,
    embeddingSetDimensions: embeddingSet.dimensions,
    embeddingSetModelId: embeddingSet.modelId,
  };
}

function calculateLatency(rows: Array<{ runAt: string; updatedAt: string }>): {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
} {
  if (rows.length === 0) {
    return { avgMs: 0, p50Ms: 0, p95Ms: 0 };
  }

  const durations = rows
    .map((row) => {
      const startedAt = Date.parse(row.runAt);
      const finishedAt = Date.parse(row.updatedAt);
      if (!(Number.isFinite(startedAt) && Number.isFinite(finishedAt))) {
        return null;
      }
      return Math.max(0, finishedAt - startedAt);
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (durations.length === 0) {
    return { avgMs: 0, p50Ms: 0, p95Ms: 0 };
  }

  const average = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  const percentile = (q: number): number => {
    const index = Math.min(durations.length - 1, Math.floor(q * durations.length));
    return durations[index] ?? average;
  };

  return {
    avgMs: average,
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
  };
}

async function buildQueueSnapshot(
  db: PGlite,
  embeddingSetId: string | null
): Promise<VectorQueueSnapshot> {
  const executor = createDbAdapter(db);
  const jobQueue = new JobQueue(executor);

  const since = new Date(Date.now() - 60_000).toISOString();

  const [queueStats, throughputRows, lastErrorRows, latencyRows, coverage] = await Promise.all([
    jobQueue.getQueueStats(EMBEDDINGS_QUEUE_NAME),
    executor.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM job_queue
        WHERE queue = $1 AND state = 'succeeded' AND updated_at >= $2`,
      [EMBEDDINGS_QUEUE_NAME, since]
    ),
    executor.query<{ error: string | null }>(
      `SELECT error
         FROM job_queue
        WHERE state = 'failed'
          AND queue = $1
     ORDER BY updated_at DESC
        LIMIT 1`,
      [EMBEDDINGS_QUEUE_NAME]
    ),
    executor.query<{ runAt: string; updatedAt: string }>(
      `SELECT run_at AS "runAt", updated_at AS "updatedAt"
         FROM job_queue
        WHERE queue = $1
          AND state = 'succeeded'
          AND updated_at >= $2
     ORDER BY updated_at DESC
        LIMIT 200`,
      [EMBEDDINGS_QUEUE_NAME, since]
    ),
    embeddingSetId
      ? new FileChunkRepository(db).getCoverageForSet(embeddingSetId)
      : Promise.resolve({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 }),
  ]);

  const stats = queueStats[0];
  const queueCounts = stats
    ? {
        queued: stats.queued,
        running: stats.running,
        failed: stats.failed,
        succeeded: stats.succeeded,
      }
    : { queued: 0, running: 0, failed: 0, succeeded: 0 };

  const throughput = Number(throughputRows.rows[0]?.count ?? 0);
  const lastError = lastErrorRows.rows[0]?.error ?? null;
  const latency = calculateLatency(latencyRows.rows);

  const coverageSnapshot =
    embeddingSetId && coverage.totalChunks > 0
      ? { total: coverage.totalChunks, withSet: coverage.chunksWithEmbeddingsForSet }
      : null;

  return {
    coverage: coverageSnapshot,
    queueCounts,
    throughput,
    lastError,
    latency,
  };
}

function createEmbeddingSetsDeps(): EmbeddingSetsToolDependencies {
  return {
    listSets: async () => {
      const db = (await getDatabase()) as unknown as PGlite;
      return await createEmbeddingSetsRepository(db).findAll();
    },
    createSet: async (modelKey: string, name: string, description?: string) => {
      const parsed = parseProviderModelKey(modelKey);
      if (!parsed) {
        throw new Error(EMBEDDING_SETS_ERROR_MESSAGES.invalidModelKey);
      }

      if (!isHostedProvider(parsed.provider)) {
        throw new Error(EMBEDDING_SETS_ERROR_MESSAGES.invalidModelKey);
      }

      const db = (await getDatabase()) as unknown as PGlite;
      const repo = createEmbeddingSetsRepository(db);

      const providerMetadata = resolveHostedProviderMetadata(parsed.provider, parsed.modelId);
      if (!providerMetadata) {
        throw new Error(EMBEDDING_SETS_ERROR_MESSAGES.modelNotFound);
      }

      const dimensions = providerMetadata.dimensions;
      const distance = providerMetadata.distance;

      const existingSets = await repo.getByModelKey(modelKey);
      const existing = existingSets
        .filter(
          (set) =>
            set.modelId === parsed.modelId &&
            set.dimensions === dimensions &&
            set.distance === distance
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .at(0);
      if (existing) {
        return { set: existing, created: false };
      }

      const set = await repo.getOrCreateSet(modelKey, parsed.modelId, dimensions, distance, {
        name,
        ...(description ? { description } : {}),
      });
      return { set, created: true };
    },
    getCoverageStats: async () => {
      const db = (await getDatabase()) as unknown as PGlite;
      const sets = await createEmbeddingSetsRepository(db).findAll();
      const chunkRepository = new FileChunkRepository(db);

      const stats: Record<
        string,
        { totalChunks: number; embeddedChunks: number; coveragePercent: number }
      > = {};

      for (const set of sets) {
        const coverage = await chunkRepository.getCoverageForSet(set.id);
        const totalChunks = coverage.totalChunks;
        const embeddedChunks = coverage.chunksWithEmbeddingsForSet;
        const coveragePercent = totalChunks > 0 ? (embeddedChunks / totalChunks) * 100 : 0;
        stats[set.id] = { totalChunks, embeddedChunks, coveragePercent };
      }

      return stats;
    },
    logger,
  };
}

interface FileTreeRecord {
  id: string;
  name: string;
  path: string;
  size: number;
  tokenCount: number | null;
  updatedAt: string;
}

async function fetchFileTreeRecords(
  db: PGlite,
  prefix: string,
  limit: number
): Promise<FileTreeRecord[]> {
  const rows = await queryRows<{
    id: string;
    name: string;
    path: string;
    size: number;
    tokenCount: number | null;
    updatedAt: string;
  }>(
    db,
    prefix
      ? `SELECT id, name, path, size, token_count AS "tokenCount", updated_at AS "updatedAt"
           FROM file_records
          WHERE path LIKE $1
       ORDER BY path
          LIMIT $2`
      : `SELECT id, name, path, size, token_count AS "tokenCount", updated_at AS "updatedAt"
           FROM file_records
       ORDER BY path
          LIMIT $1`,
    prefix ? [`${prefix}%`, limit] : [limit]
  );

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      path: normalizePath(row.path),
      size: Number(row.size),
      tokenCount: row.tokenCount !== null ? Number(row.tokenCount) : null,
      updatedAt: row.updatedAt,
    }))
    .filter((row) => row.path.startsWith(prefix));
}

function filterFileTreeRecords(
  rows: readonly FileTreeRecord[],
  options: {
    prefix: string;
    maxDepth: number;
    includeHidden: boolean;
    pattern?: string | undefined;
  }
): FileTreeRecord[] {
  return rows.filter((row) => {
    if (!options.includeHidden && isHiddenPath(row.path)) {
      return false;
    }

    if (options.pattern && !fileFilter.matchWildcard(row.path, options.pattern)) {
      return false;
    }

    const relative = options.prefix ? row.path.slice(options.prefix.length) : row.path;
    const segments = relative.split('/').filter((segment) => segment.length > 0);
    return segments.length <= options.maxDepth;
  });
}

async function fetchChunkedFileRecordIds(
  db: PGlite,
  fileIds: readonly string[]
): Promise<Set<string>> {
  if (fileIds.length === 0) {
    return new Set();
  }

  const rows = await queryRows<{ fileRecordId: string }>(
    db,
    'SELECT DISTINCT file_record_id AS "fileRecordId" FROM file_chunks WHERE file_record_id = ANY($1::uuid[])',
    [fileIds]
  );

  return new Set(rows.map((row) => row.fileRecordId));
}

function recordDirectoryChild(
  directoryChildren: Map<string, Set<string>>,
  parent: string,
  child: string
): void {
  const existing = directoryChildren.get(parent);
  if (existing) {
    existing.add(child);
    return;
  }
  directoryChildren.set(parent, new Set([child]));
}

function buildDirectoryIndex(
  files: readonly FileTreeRecord[],
  options: { prefix: string; normalizedDir: string; maxDepth: number }
): { directoryChildren: Map<string, Set<string>>; directoryPaths: Set<string> } {
  const directoryChildren = new Map<string, Set<string>>();
  const directoryPaths = new Set<string>();

  for (const file of files) {
    const relative = options.prefix ? file.path.slice(options.prefix.length) : file.path;
    const segments = relative.split('/').filter((segment) => segment.length > 0);

    const rootDir = options.normalizedDir || (file.path.startsWith('/') ? '/' : '');
    let currentDir = rootDir;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }

      recordDirectoryChild(directoryChildren, currentDir, segment);

      const nextDir = joinPath(currentDir, segment);
      const isLeaf = index === segments.length - 1;
      if (!isLeaf && index + 1 <= options.maxDepth) {
        directoryPaths.add(nextDir);
      }
      currentDir = nextDir;
    }
  }

  return { directoryChildren, directoryPaths };
}

function buildDirectoryEntries(
  directoryPaths: Set<string>,
  directoryChildren: Map<string, Set<string>>
): FileEntry[] {
  return Array.from(directoryPaths)
    .sort((a, b) => a.localeCompare(b))
    .map((dirPath) => {
      const childCount = directoryChildren.get(dirPath)?.size;
      return {
        id: `dir:${dirPath}`,
        name: getDirName(dirPath),
        path: dirPath,
        isDirectory: true,
        size: null,
        tokenCount: null,
        isChunked: false,
        ...(typeof childCount === 'number' ? { childCount } : {}),
      };
    });
}

function buildFileEntries(files: readonly FileTreeRecord[], chunkedIds: Set<string>): FileEntry[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      id: file.id,
      name: file.name,
      path: file.path,
      isDirectory: false,
      size: file.size,
      tokenCount: file.tokenCount,
      isChunked: chunkedIds.has(file.id),
      modifiedAt: file.updatedAt,
    }));
}

function compareFileEntries(a: FileEntry, b: FileEntry): number {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function createFileTreeDeps(): FileTreeToolDependencies {
  return {
    listFiles: async (path: string, options) => {
      const normalizedDir = normalizePath(path);
      const prefix = normalizedDir === '/' ? '/' : normalizedDir ? `${normalizedDir}/` : '';

      const maxDepth = options.maxDepth ?? 3;
      const includeHidden = options.includeHidden ?? false;
      const limit = options.limit ?? 100;
      const pattern = options.pattern;

      const db = (await getDatabase()) as unknown as PGlite;

      const sqlLimit = Math.max(limit * 10, limit);
      const fileRecords = await fetchFileTreeRecords(db, prefix, sqlLimit);
      const filteredFiles = filterFileTreeRecords(fileRecords, {
        prefix,
        maxDepth,
        includeHidden,
        pattern,
      });

      const fileIds = filteredFiles.map((row) => row.id);
      const chunkedIds = await fetchChunkedFileRecordIds(db, fileIds);

      const { directoryChildren, directoryPaths } = buildDirectoryIndex(filteredFiles, {
        prefix,
        normalizedDir,
        maxDepth,
      });
      const directoryEntries = buildDirectoryEntries(directoryPaths, directoryChildren);
      const fileEntries = buildFileEntries(filteredFiles, chunkedIds);

      const combined = [...directoryEntries, ...fileEntries].sort(compareFileEntries);

      const truncated = combined.length > limit;
      const entries = truncated ? combined.slice(0, limit) : combined;

      return { entries, truncated };
    },
    logger,
  };
}

function createHybridSearchDeps(): HybridSearchToolDependencies {
  return {
    generateQueryEmbedding: async (embeddingSetId: string, query: string) => {
      const db = (await getDatabase()) as unknown as PGlite;
      const { embedding } = await generateHostedQueryEmbedding(db, embeddingSetId, query);
      return embedding;
    },
    performHybridSearch: async (queryText: string, queryEmbedding: number[], options) => {
      const db = (await getDatabase()) as unknown as PGlite;

      const service = new HybridSearchService(new FileChunkRepository(db));
      const response = await service.search(queryText, queryEmbedding, {
        embeddingSetId: options.embeddingSetId,
        limit: options.limit,
        vectorWeight: options.vectorWeight,
        ftsWeight: options.ftsWeight,
        ...(options.vectorThreshold !== undefined
          ? { vectorThreshold: options.vectorThreshold }
          : {}),
        ...(options.filePaths !== undefined ? { filePaths: options.filePaths } : {}),
        ...(options.chunkType !== undefined ? { chunkType: options.chunkType } : {}),
      });

      const results: HybridSearchServiceResult[] = response.results.map((result) => ({
        chunk: {
          id: result.chunk.id,
          content: result.chunk.content,
          chunkIndex: result.chunk.chunkIndex,
          chunkType: result.chunk.chunkType,
          fileRecordId: result.chunk.fileRecordId,
        },
        rrfScore: result.rrfScore,
        sourceCount: result.sourceCount,
        ...(result.vectorSimilarity !== undefined
          ? { vectorSimilarity: result.vectorSimilarity }
          : {}),
        ...(result.ftsRank !== undefined ? { ftsRank: result.ftsRank } : {}),
        ...(result.headline !== undefined ? { headline: result.headline } : {}),
        position: result.position,
      }));

      const metadata: HybridSearchServiceMetadata = {
        vectorResultCount: response.metadata.vectorResultCount,
        ftsResultCount: response.metadata.ftsResultCount,
        fusedResultCount: response.metadata.fusedResultCount,
        totalMs: response.metadata.totalMs,
      };

      return { results, metadata };
    },
    resolveFileRecords: async (fileRecordIds: string[]) => {
      const db = (await getDatabase()) as unknown as PGlite;
      const repo = new FileRecordRepository(db);
      const records = await repo.findByIds(fileRecordIds);
      const map = new Map<string, { id: string; name: string; path: string }>();
      for (const record of records) {
        map.set(record.id, { id: record.id, name: record.name, path: record.path });
      }
      return map;
    },
    logger,
  };
}

function createQueueStatusDeps(runtimeData: RuntimeData | undefined): QueueStatusToolDependencies {
  return {
    getQueueSnapshot: async (embeddingSetId: string | null) => {
      const db = (await getDatabase()) as unknown as PGlite;
      const resolvedSetId = embeddingSetId ?? runtimeData?.embeddingSetId ?? null;
      return await buildQueueSnapshot(db, resolvedSetId);
    },
    getEmbeddingSetName: async (embeddingSetId: string) => {
      const db = (await getDatabase()) as unknown as PGlite;
      const set = await createEmbeddingSetsRepository(db).getById(embeddingSetId);
      return set?.name;
    },
    logger,
  };
}

function createDiagnosticsDeps(runtimeData: RuntimeData | undefined): DiagnosticsToolDependencies {
  return {
    getDatabaseHealth: async () => {
      try {
        const db = (await getDatabase()) as unknown as PGlite;
        const [fileRecords, chunks, embeddings, sets] = await Promise.all([
          queryRows<{ count: string }>(db, 'SELECT COUNT(*)::text AS count FROM file_records'),
          queryRows<{ count: string }>(db, 'SELECT COUNT(*)::text AS count FROM file_chunks'),
          queryRows<{ count: string }>(
            db,
            'SELECT COUNT(*)::text AS count FROM file_chunks WHERE embedding IS NOT NULL'
          ),
          queryRows<{ count: string }>(db, 'SELECT COUNT(*)::text AS count FROM embedding_sets'),
        ]);

        return {
          status: 'healthy',
          connected: true,
          tables: {
            fileRecords: Number(fileRecords[0]?.count ?? 0),
            chunks: Number(chunks[0]?.count ?? 0),
            embeddings: Number(embeddings[0]?.count ?? 0),
            embeddingSets: Number(sets[0]?.count ?? 0),
          },
          sizeBytes: 0,
        };
      } catch (error) {
        logger.error('Database diagnostics failed', { error });
        return {
          status: 'unhealthy',
          connected: false,
          tables: { fileRecords: 0, chunks: 0, embeddings: 0, embeddingSets: 0 },
          sizeBytes: 0,
        };
      }
    },
    getQueueHealth: async () => {
      const db = (await getDatabase()) as unknown as PGlite;
      const executor = createDbAdapter(db);
      const jobQueue = new JobQueue(executor);
      const stats = await jobQueue.getQueueStats(EMBEDDINGS_QUEUE_NAME);
      const snapshot = await buildQueueSnapshot(db, runtimeData?.embeddingSetId ?? null);
      const recentErrors = await executor.query<{ error: string | null }>(
        `SELECT error
           FROM job_queue
          WHERE state = 'failed'
            AND queue = $1
       ORDER BY updated_at DESC
          LIMIT 5`,
        [EMBEDDINGS_QUEUE_NAME]
      );

      const queueCounts = stats[0] ?? { queued: 0, running: 0, failed: 0, succeeded: 0 };
      const status = queueCounts.failed > 0 ? 'degraded' : 'healthy';

      return {
        status,
        durableQueue: {
          queued: queueCounts.queued,
          running: queueCounts.running,
          failed: queueCounts.failed,
          succeeded: queueCounts.succeeded,
        },
        ephemeralQueue: { pending: 0, processing: 0 },
        throughput: snapshot.throughput,
        recentErrors: recentErrors.rows
          .map((row) => row.error)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      };
    },
    logger,
  };
}

/**
 * Builds the Mastra ToolsInput for the desktop assistant server.
 * Note: `brainstrike.retrieveContext` is added separately via buildAssistantTools().
 */
export function buildDesktopAssistantTools(runtimeData: RuntimeData | undefined): MastraTools {
  const tools = {
    ...buildToolsWithEmbeddingSets(createEmbeddingSetsDeps()),
    ...buildToolsWithFileTree(createFileTreeDeps()),
    ...buildToolsWithHybridSearch(createHybridSearchDeps()),
    ...buildToolsWithQueueStatus(createQueueStatusDeps(runtimeData)),
    ...buildToolsWithDiagnostics(createDiagnosticsDeps(runtimeData)),
  };

  return tools as unknown as MastraTools;
}
