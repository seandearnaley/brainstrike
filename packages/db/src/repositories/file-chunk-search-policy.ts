import type {
  ChunkSearchResult,
  FileChunk,
  FTSQueryMode,
  FTSSearchResult,
} from '../models/file-chunk.js';

export type ChunkVectorDistance = 'cosine' | 'ip' | 'l2';
export type ChunkVectorPrecision = 'exact' | 'halfvec';

export interface ChunkSearchScopeInput {
  filePaths?: readonly string[] | undefined;
  selectionSnapshotId?: string | undefined;
}

export interface RawVectorSearchScope extends ChunkSearchScopeInput {
  chunkType?: string | undefined;
  embeddingSetId: string;
  fileRecordId?: string | undefined;
  rootId?: string | undefined;
  rootIds?: readonly string[] | undefined;
}

export interface RawFullTextSearchScope extends ChunkSearchScopeInput {
  chunkType?: string | undefined;
  embeddingSetId?: string | undefined;
  fileRecordId?: string | undefined;
  rootIds?: readonly string[] | undefined;
}

export function normalizeChunkSearchScope(scope: ChunkSearchScopeInput): {
  filePaths: string[] | undefined;
  selectionSnapshotId: string | undefined;
} {
  const trimmedPaths = scope.filePaths
    ?.map((path) => path.trim())
    .filter((path) => path.length > 0);
  return {
    filePaths:
      trimmedPaths && trimmedPaths.length > 0 ? Array.from(new Set(trimmedPaths)) : undefined,
    selectionSnapshotId: scope.selectionSnapshotId?.trim() || undefined,
  };
}

export function tsqueryFunctionForMode(mode: FTSQueryMode): string {
  switch (mode) {
    case 'plain':
      return 'plainto_tsquery';
    case 'phrase':
      return 'phraseto_tsquery';
    default:
      return 'websearch_to_tsquery';
  }
}

/**
 * ANN ranking and scores use the same halfvec cast as the partial HNSW index.
 * Exact routing uses the full-precision column so it cannot select that index.
 * Scores near a threshold can differ between the fp16 and fp32 routes.
 */
export function buildChunkDistanceExpressions(
  distance: ChunkVectorDistance,
  dimension: number,
  precision: ChunkVectorPrecision = 'halfvec',
  maximumDimension?: number
): { orderExpr: string; similarityExpr: string } {
  if (
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    (maximumDimension !== undefined && dimension > maximumDimension)
  ) {
    throw new Error('buildChunkDistanceExpressions dimension must be a positive integer');
  }
  const embeddingCast = precision === 'exact' ? 'embedding' : `(embedding::halfvec(${dimension}))`;
  const paramCast =
    precision === 'exact' ? `$1::vector(${dimension})` : `$1::halfvec(${dimension})`;

  if (distance === 'l2') {
    return {
      orderExpr: `${embeddingCast} <-> ${paramCast}`,
      similarityExpr: `(1.0 / (1.0 + (${embeddingCast} <-> ${paramCast})))`,
    };
  }
  if (distance === 'ip') {
    return {
      orderExpr: `${embeddingCast} <#> ${paramCast}`,
      similarityExpr: `(1.0 / (1.0 + exp(+(${embeddingCast} <#> ${paramCast}))))`,
    };
  }
  return {
    orderExpr: `${embeddingCast} <=> ${paramCast}`,
    similarityExpr: `(1 - ((${embeddingCast} <=> ${paramCast}) / 2.0))`,
  };
}

export function buildRawVectorScopePlan(
  startIndex: number,
  scope: RawVectorSearchScope
): { clauses: string[]; narrowed: boolean; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startIndex;
  const appendEquality = (column: string, value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    clauses.push(`${column} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  };

  appendEquality('file_record_id', scope.fileRecordId);
  appendEquality('chunk_type', scope.chunkType);
  paramIndex = appendRawAllowlistClauses(clauses, values, paramIndex, scope);
  const narrowed = clauses.length > 0;
  clauses.push(`embedding_set_id = $${paramIndex}`);
  values.push(scope.embeddingSetId);
  return { clauses, narrowed, values };
}

function appendRawAllowlistClauses(
  clauses: string[],
  values: unknown[],
  startIndex: number,
  scope: ChunkSearchScopeInput & {
    rootId?: string | undefined;
    rootIds?: readonly string[] | undefined;
  }
): number {
  let paramIndex = startIndex;
  if (scope.selectionSnapshotId) {
    clauses.push(
      `EXISTS (\n          SELECT 1\n          FROM selection_snapshot_files ssf\n          JOIN selection_snapshots ss ON ss.id = ssf.snapshot_id\n          JOIN file_records fr ON fr.path = ssf.file_path\n          WHERE ssf.snapshot_id = $${paramIndex}\n            AND (ss.expires_at IS NULL OR ss.expires_at > NOW())\n            AND fr.id = file_chunks.file_record_id\n        )`
    );
    values.push(scope.selectionSnapshotId);
    paramIndex += 1;
  }
  if (scope.filePaths && scope.filePaths.length > 0) {
    clauses.push(
      `file_record_id IN (\n          SELECT id FROM file_records\n          WHERE path = ANY($${paramIndex}::text[])\n        )`
    );
    values.push(scope.filePaths);
    paramIndex += 1;
  }
  if (scope.rootId !== undefined) {
    clauses.push(`file_record_id IN (SELECT id FROM file_records WHERE root_id = $${paramIndex})`);
    values.push(scope.rootId);
    paramIndex += 1;
  }
  if (scope.rootIds !== undefined) {
    clauses.push(
      `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($${paramIndex}::text[]))`
    );
    values.push(Array.from(scope.rootIds));
    paramIndex += 1;
  }
  return paramIndex;
}

export function buildRawFullTextScopePlan(
  startIndex: number,
  scope: RawFullTextSearchScope
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startIndex;
  const appendEquality = (column: string, value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    clauses.push(`${column} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  };
  appendEquality('file_record_id', scope.fileRecordId);
  appendEquality('chunk_type', scope.chunkType);
  if (scope.embeddingSetId !== undefined) {
    clauses.push(
      `(embedding_set_id = $${paramIndex} OR (embedding_set_id IS NULL AND file_record_id IN (SELECT id FROM file_records WHERE embedding_set_id = $${paramIndex})))`
    );
    values.push(scope.embeddingSetId);
    paramIndex += 1;
  }
  appendRawAllowlistClauses(clauses, values, paramIndex, scope);
  return { clauses, values };
}

export function mapVectorSearchRows<
  T extends { rank: string | number; similarity: string | number },
>(
  rows: readonly T[],
  mapChunk: (row: T) => FileChunk,
  threshold: number,
  limit: number
): ChunkSearchResult[] {
  return rows
    .map((row) => ({
      chunk: mapChunk(row),
      rank: Number(row.rank),
      similarity: Number(row.similarity),
    }))
    .filter((result) => Number.isFinite(result.similarity) && result.similarity >= threshold)
    .slice(0, limit);
}

export function mapFullTextSearchRows<
  T extends { fts_rank: string | number; headline?: string | null; position: string | number },
>(
  rows: readonly T[],
  mapChunk: (row: T) => FileChunk,
  matchKind: FTSSearchResult['matchKind'],
  threshold: number
): FTSSearchResult[] {
  const results: FTSSearchResult[] = [];
  for (const row of rows) {
    const rank = Number(row.fts_rank);
    if (matchKind === 'exact' && threshold > 0 && rank < threshold) {
      continue;
    }
    results.push({
      chunk: mapChunk(row),
      matchKind,
      position: Number(row.position),
      rank,
      ...(row.headline ? { headline: row.headline } : {}),
    });
  }
  return results;
}
