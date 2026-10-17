/**
 * A `RetrievalStore` over a PGlite catalog, for retrieval-tool suites that seed
 * SQL rows. Production Main reads the StateStore catalog
 * (`assistant-server/retrieval-store-catalog.ts`); desktop opens no PGlite.
 */
import { EmbeddingSetsRepository, FileRecordRepository } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import {
  RETRIEVAL_ERROR_MESSAGES,
  redactRetrievalErrorForLog,
} from '../../assistant-server/retrieval-core';
import type {
  EmbeddingSetRow,
  FileRecordRow,
  RetrievalStore,
} from '../../assistant-server/retrieval-store';

type DesktopDatabase = ConstructorParameters<typeof EmbeddingSetsRepository>[0] &
  ConstructorParameters<typeof FileRecordRepository>[0];

const logger = createLogger('AssistantRetrievalTool');

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

/** The store over the database `getDatabase` resolves for each read. */
export function pgliteRetrievalStore(getDatabase: () => Promise<DesktopDatabase>): RetrievalStore {
  return {
    embeddingSet: async (embeddingSetId) =>
      resolveEmbeddingSet(await getDatabase(), embeddingSetId),
    embeddingSpaces: async ({ includeStats }) =>
      new EmbeddingSetsRepository(await getDatabase()).listEmbeddingSpaces({ includeStats }),
    fileRecords: async (ids) => {
      const db = await getDatabase();
      return buildFileRecordMap(new FileRecordRepository(db), db, ids);
    },
  };
}
