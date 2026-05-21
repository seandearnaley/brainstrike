import {
  canonicalizeEmbeddingProviderModelKey,
  type EmbeddingProviderType,
  formatEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/utils/logger';

interface SqlClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface EmbeddingSetRow {
  createdAt: string;
  dimensions: number;
  distance: string;
  id: string;
  modelId: string;
  modelKey: string;
}

interface ChunkCountRow {
  count: number;
  embeddingSetId: string;
}

type NormalizedRow = EmbeddingSetRow & {
  canonicalKey: string;
  chunkCount: number;
};

const logger = createLogger('EmbeddingSetNormalizer');

let normalizationPromise: Promise<void> | null = null;

export async function normalizeEmbeddingSets(db: SqlClient | null | undefined): Promise<void> {
  if (!db) {
    return;
  }
  if (!normalizationPromise) {
    normalizationPromise = normalize(db)
      .catch((error) => {
        logger.error('Failed to normalize embedding sets', { error });
      })
      .finally(() => {
        normalizationPromise = null;
      });
  }
  await normalizationPromise;
}

async function normalize(db: SqlClient): Promise<void> {
  const sets = await fetchEmbeddingSets(db);
  if (!sets.length) {
    return;
  }
  const counts = await fetchChunkCounts(db);
  const groups = groupEmbeddingSets(sets, counts);
  for (const rows of groups.values()) {
    await reconcileGroup(db, rows);
  }
}

async function fetchEmbeddingSets(db: SqlClient): Promise<EmbeddingSetRow[]> {
  const result = await db.query<EmbeddingSetRow>(
    `SELECT id,
            model_key AS "modelKey",
            model_id AS "modelId",
            dimensions,
            distance,
            created_at AS "createdAt"
       FROM embedding_sets`
  );
  return result.rows;
}

async function fetchChunkCounts(db: SqlClient): Promise<Map<string, number>> {
  const countsResult = await db.query<ChunkCountRow>(
    `SELECT embedding_set_id AS "embeddingSetId",
            COUNT(*)::INTEGER AS "count"
       FROM file_chunks
   GROUP BY embedding_set_id`
  );
  const map = new Map<string, number>();
  for (const row of countsResult.rows) {
    map.set(String(row.embeddingSetId), Number(row.count ?? 0));
  }
  return map;
}

function groupEmbeddingSets(
  rows: EmbeddingSetRow[],
  counts: Map<string, number>
): Map<string, NormalizedRow[]> {
  const groups = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    const normalized = toNormalizedRow(row, counts);
    const key = `${normalized.canonicalKey}__${row.dimensions}__${row.distance}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(normalized);
    } else {
      groups.set(key, [normalized]);
    }
  }
  return groups;
}

function toNormalizedRow(row: EmbeddingSetRow, counts: Map<string, number>): NormalizedRow {
  const canonical = canonicalizeEmbeddingProviderModelKey(row.modelKey) ?? {
    provider: 'local' as EmbeddingProviderType,
    modelId: row.modelId || row.modelKey,
    composite: formatEmbeddingProviderModelKey('local', row.modelId || row.modelKey),
  };
  return {
    ...row,
    canonicalKey: canonical.composite,
    chunkCount: counts.get(row.id) ?? 0,
  };
}

async function reconcileGroup(db: SqlClient, rows: NormalizedRow[]): Promise<void> {
  if (!rows.length) {
    return;
  }
  const sorted = sortEmbeddingRows(rows);
  const [primary, ...duplicates] = sorted;
  if (!primary) {
    return;
  }
  await ensureCanonicalKey(db, primary);
  for (const duplicate of duplicates) {
    if (!duplicate) {
      continue;
    }
    await mergeDuplicate(db, primary, duplicate);
  }
}

function sortEmbeddingRows(rows: NormalizedRow[]): NormalizedRow[] {
  return [...rows].sort((a, b) => {
    if (b.chunkCount !== a.chunkCount) {
      return b.chunkCount - a.chunkCount;
    }
    return new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf();
  });
}

async function ensureCanonicalKey(db: SqlClient, row: NormalizedRow): Promise<void> {
  if (row.modelKey === row.canonicalKey) {
    return;
  }
  await db.query('UPDATE embedding_sets SET model_key = $1 WHERE id = $2', [
    row.canonicalKey,
    row.id,
  ]);
}

async function mergeDuplicate(
  db: SqlClient,
  primary: NormalizedRow,
  duplicate: NormalizedRow
): Promise<void> {
  if (duplicate.chunkCount > 0) {
    await db.query('UPDATE file_chunks SET embedding_set_id = $1 WHERE embedding_set_id = $2', [
      primary.id,
      duplicate.id,
    ]);
  }
  await db.query('DELETE FROM embedding_sets WHERE id = $1', [duplicate.id]);
}
