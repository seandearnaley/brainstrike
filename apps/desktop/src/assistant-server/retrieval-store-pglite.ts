/**
 * Main's retrieval store over its PGlite database, plus the legacy (no native
 * index) similarity path and hosted query embeddings. Main-only.
 */
import {
  EmbeddingSetsRepository,
  FileChunkRepository,
  FileRecordRepository,
  HybridSearchService,
} from '@brainstrike/db';
import {
  type HostedProviderType,
  hostedProviderRequiresApiKey,
} from '@brainstrike/embeddings/provider-core';
import { createLogger } from '@brainstrike/logging';
import { type DesktopDatabase, getDatabase } from '../db-main';
import { createHostedProvider, resolveEmbeddingApiKey } from '../hosted-embeddings';
import {
  assertValidSelectionFilePaths,
  assertValidSelectionSnapshotId,
  RETRIEVAL_ERROR_MESSAGES,
  redactRetrievalErrorForLog,
} from './retrieval-core';
import type { EmbeddingSetRow, FileRecordRow, RetrievalStore } from './retrieval-store';

const logger = createLogger('AssistantRetrievalTool');
/** Snapshot time-to-live (ms). Expired snapshots are best-effort cleaned up. */
const SNAPSHOT_TTL_MS = 1000 * 60 * 60; // 1 hour

interface QueryResult<T> {
  rows: T[];
}

async function resolveEmbeddingSet(
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
      error: redactRetrievalErrorForLog(error),
    });
    throw new Error(RETRIEVAL_ERROR_MESSAGES.embeddingSetLookupFailed);
  }
  const row = result.rows[0];
  if (!(row?.modelKey && row.modelId && row.dimensions)) {
    throw new Error(RETRIEVAL_ERROR_MESSAGES.invalidEmbeddingSet);
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
    throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed);
  }
  assertValidSelectionSnapshotId(snapshotId);
  await db.query(
    `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
     SELECT $1, UNNEST($2::text[])`,
    [snapshotId, filePaths]
  );
  return snapshotId;
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

async function buildFileRecordMap(
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
    throw new Error(RETRIEVAL_ERROR_MESSAGES.missingApiKey);
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
      error: redactRetrievalErrorForLog(result.error),
      provider,
      stage: 'provider-request',
    });
    throw new Error(RETRIEVAL_ERROR_MESSAGES.embeddingFailed);
  }
  return result.value.embedding;
}

/** The store over Main's own PGlite database. */
export function pgliteRetrievalStore(): RetrievalStore {
  return {
    embeddingSet: async (embeddingSetId) =>
      resolveEmbeddingSet(await getDatabase(), embeddingSetId),
    embeddingSpaces: async ({ includeStats }) =>
      new EmbeddingSetsRepository(await getDatabase()).listEmbeddingSpaces({ includeStats }),
    fileRecords: async (ids) => {
      const db = await getDatabase();
      return buildFileRecordMap(new FileRecordRepository(db), db, ids);
    },
    legacy: {
      createSelectionSnapshot: async (filePaths) =>
        createSelectionSnapshot(await getDatabase(), filePaths),
      hostedQueryEmbedding: ({ dimensions, modelId, provider, query, signal }) =>
        generateQueryEmbedding(provider, modelId, dimensions, query, signal),
      hybridSearch: async (query, embedding, options) =>
        new HybridSearchService(new FileChunkRepository(await getDatabase())).search(
          query,
          embedding,
          options
        ),
      searchSimilar: async (embedding, options) =>
        new FileChunkRepository(await getDatabase()).searchSimilar(embedding, options),
    },
  };
}
