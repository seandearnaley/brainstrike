import { createLogger, getErrorMessage } from '@brainstrike/utils';
import type {
  CreateIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  DeleteVectorsParams,
  DescribeIndexParams,
  IndexStats,
  QueryResult,
  QueryVectorParams,
  UpdateVectorParams,
  UpsertVectorParams,
} from '@mastra/core/vector';
import { MastraVector } from '@mastra/core/vector';
import { type AssistantRunEventSink, emitAssistantRunEventSafely } from '../run-events';
import { MASTRA_VECTOR_TABLE } from './sql';
import type { PgliteDatabase, PgliteQueryValue } from './types';

const logger = createLogger('PgliteVectorStore');

type PgliteVectorFilter = Record<string, unknown> | null | undefined;

interface PgliteVectorStoreOptions {
  database: PgliteDatabase;
  eventSink?: AssistantRunEventSink;
  id?: string;
  runId?: string;
}

interface IndexRow {
  count: number | string;
  dimension: number | string;
  indexName: string;
  metric: IndexStats['metric'];
  [key: string]: unknown;
}

interface VectorRow {
  embedding: number[] | string | null;
  id: string;
  metadata: Record<string, unknown> | string | null;
  score: number | string;
  [key: string]: unknown;
}

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 1000;
const DEFAULT_METRIC: NonNullable<IndexStats['metric']> = 'cosine';
const INDEX_METADATA_ID = '__index_metadata__';
const MASTRA_VECTOR_SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS ${MASTRA_VECTOR_TABLE} (
    index_name TEXT NOT NULL,
    id TEXT NOT NULL,
    embedding vector NOT NULL,
    metadata JSONB,
    dimension INTEGER NOT NULL,
    metric TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (index_name, id)
  );
  CREATE INDEX IF NOT EXISTS mastra_vectors_index_name_idx
    ON ${MASTRA_VECTOR_TABLE} (index_name);
  CREATE INDEX IF NOT EXISTS mastra_vectors_metadata_idx
    ON ${MASTRA_VECTOR_TABLE} USING gin (metadata);
`;
const VECTOR_OPERATORS = {
  cosine: '<=>',
  dotproduct: '<#>',
  euclidean: '<->',
} as const satisfies Record<NonNullable<IndexStats['metric']>, string>;
// halfvec HNSW indexes support up to 4000 dimensions (vs 2000 for full-precision
// vector), and hosted embedders in the registry emit up to 3072 — so the fp16
// path is mandatory for large models, not just a size optimization. Mirrors
// packages/db/src/migrations/dimension-index-helpers.ts (file_chunks), which is
// hardwired to that table; mastra_vectors owns its own simpler variant here.
const MAX_HNSW_DIMENSION = 4000;
const HNSW_OPCLASSES = {
  cosine: 'halfvec_cosine_ops',
  dotproduct: 'halfvec_ip_ops',
  euclidean: 'halfvec_l2_ops',
} as const satisfies Record<NonNullable<IndexStats['metric']>, string>;

function dimensionIndexName(dimension: number, metric: NonNullable<IndexStats['metric']>): string {
  return `idx_mastra_vectors_emb_hnsw_${dimension}_${metric}`;
}

/**
 * Transaction-scoped pgvector tuning for filtered HNSW searches (mirrors
 * `hnswSearchTuningStatements` in packages/db, which is hardwired to that
 * package's tables/env plumbing). Every query here filters by `index_name`
 * AFTER the ANN candidate window, and all logical indexes sharing a
 * (dimension, metric) live in ONE physical graph — so with pgvector's default
 * `ef_search = 40` a minority logical index can under-return. Widening the
 * window and enabling `strict_order` iterative scans keeps the index walking
 * until enough rows survive the filter. `strict_order` (not relaxed) because
 * the query relies on the index's emission order directly (single
 * `ORDER BY <distance> LIMIT n`, no downstream re-sort). `SET LOCAL` is a
 * silent no-op outside a transaction, so these MUST run inside the same
 * transaction as the SELECT.
 */
const HNSW_SEARCH_TUNING_STATEMENTS: readonly string[] = [
  'SET LOCAL hnsw.ef_search = 100',
  "SET LOCAL hnsw.iterative_scan = 'strict_order'",
];

function vectorLiteral(vector: number[]): string {
  if (vector.length === 0) {
    throw new Error('Vector cannot be empty');
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('Vector values must be finite numbers');
    }
  }
  return `[${vector.join(',')}]`;
}

function parseVector(value: number[] | string | null): number[] | undefined {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .filter((part) => part.trim().length > 0)
    .map((part) => {
      const component = Number(part);
      if (!Number.isFinite(component)) {
        throw new Error(`Invalid vector component: ${part}`);
      }
      return component;
    });
}

function parseMetadata(
  value: Record<string, unknown> | string | null
): Record<string, unknown> | undefined {
  if (!value) {
    return;
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }
  return value;
}

function assertIndexName(indexName: string): void {
  if (!indexName.trim()) {
    throw new Error('indexName is required');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(indexName)) {
    throw new Error(`Unsupported index name: ${indexName}`);
  }
}

function assertFilterKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Unsupported vector filter key: ${key}`);
  }
}

function appendEqualityFilter(
  key: string,
  value: unknown,
  values: PgliteQueryValue[],
  clauses: string[]
): void {
  values.push(key);
  const keyParam = `$${values.length}`;
  values.push(String(value));
  clauses.push(`metadata ->> ${keyParam} = $${values.length}`);
}

function appendOperatorFilter(
  key: string,
  value: Record<string, unknown>,
  values: PgliteQueryValue[],
  clauses: string[]
): void {
  if ('$eq' in value) {
    appendEqualityFilter(key, value['$eq'], values, clauses);
    return;
  }
  if ('$in' in value) {
    const inValues = value['$in'];
    if (!Array.isArray(inValues)) {
      throw new Error('$in vector filter value must be an array');
    }
    values.push(key);
    const keyParam = `$${values.length}`;
    values.push(inValues.map((entry) => String(entry)));
    clauses.push(`metadata ->> ${keyParam} = ANY($${values.length}::text[])`);
    return;
  }
  throw new Error(`Unsupported vector filter operator for key: ${key}`);
}

function appendAndFilter(value: unknown, values: PgliteQueryValue[], clauses: string[]): void {
  if (!Array.isArray(value)) {
    throw new Error('$and vector filter must be an array');
  }
  for (const child of value) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error('$and vector filter entries must be objects');
    }
    appendFilterSql(child as Record<string, unknown>, values, clauses);
  }
}

function appendFieldFilter(
  key: string,
  value: unknown,
  values: PgliteQueryValue[],
  clauses: string[]
): void {
  assertFilterKey(key);
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    appendOperatorFilter(key, value as Record<string, unknown>, values, clauses);
    return;
  }
  appendEqualityFilter(key, value, values, clauses);
}

function appendFilterSql(
  filter: PgliteVectorFilter,
  values: PgliteQueryValue[],
  clauses: string[]
): void {
  if (!filter) {
    return;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and') {
      appendAndFilter(value, values, clauses);
      continue;
    }
    appendFieldFilter(key, value, values, clauses);
  }
}

export class PgliteVectorStore extends MastraVector<PgliteVectorFilter> {
  private readonly database: PgliteDatabase;
  private readonly eventSink: AssistantRunEventSink | undefined;
  private readonly runId: string | undefined;
  private initPromise: Promise<void> | null = null;
  private readonly dimensionIndexPromises = new Map<string, Promise<void>>();

  constructor(options: PgliteVectorStoreOptions) {
    super({ id: options.id ?? 'brainstrike-pglite-vector' });
    this.database = options.database;
    this.eventSink = options.eventSink;
    this.runId = options.runId;
  }

  override async createIndex({
    indexName,
    dimension,
    metric = DEFAULT_METRIC,
  }: CreateIndexParams): Promise<void> {
    assertIndexName(indexName);
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Error('dimension must be a positive safe integer');
    }
    await this.ensureVectorTable();
    const existing = await this.describeIndexIfExists(indexName);
    if (existing) {
      if (existing.dimension !== dimension) {
        throw new Error(
          `Vector index ${indexName} already exists with ${existing.dimension} dimensions, requested ${dimension} dimensions`
        );
      }
      if (existing.metric !== metric) {
        throw new Error(
          `Vector index ${indexName} already exists with metric ${existing.metric}, requested ${metric}`
        );
      }
      // Mastra re-declares every logical index on session init, so this branch is
      // how pre-existing installs (rows written before HNSW support) gain the
      // physical index.
      await this.ensureDimensionIndex(dimension, metric);
      return;
    }
    await this.database.query(
      `INSERT INTO ${MASTRA_VECTOR_TABLE}
        (index_name, id, embedding, metadata, dimension, metric)
       VALUES ($1, $2, $3::vector, $4::jsonb, $5, $6)
       ON CONFLICT (index_name, id) DO UPDATE SET
        dimension = EXCLUDED.dimension,
        metric = EXCLUDED.metric,
        updated_at = now()`,
      [
        indexName,
        INDEX_METADATA_ID,
        vectorLiteral(new Array(dimension).fill(0)),
        null,
        dimension,
        metric,
      ]
    );
    await this.ensureDimensionIndex(dimension, metric);
  }

  override async listIndexes(): Promise<string[]> {
    await this.ensureVectorTable();
    const result = await this.database.query<{ indexName: string }>(
      `SELECT DISTINCT index_name AS "indexName"
       FROM ${MASTRA_VECTOR_TABLE}
       ORDER BY index_name`
    );
    return result.rows.map((row) => row.indexName);
  }

  override async describeIndex({ indexName }: DescribeIndexParams): Promise<IndexStats> {
    const stats = await this.describeIndexIfExists(indexName);
    if (!stats) {
      throw new Error(`Vector index not found: ${indexName}`);
    }
    return stats;
  }

  override async deleteIndex({ indexName }: DeleteIndexParams): Promise<void> {
    await this.ensureVectorTable();
    await this.database.query(`DELETE FROM ${MASTRA_VECTOR_TABLE} WHERE index_name = $1`, [
      indexName,
    ]);
  }

  override async upsert({
    indexName,
    vectors,
    metadata,
    ids,
  }: UpsertVectorParams): Promise<string[]> {
    assertIndexName(indexName);
    if (vectors.length === 0) {
      throw new Error('vectors cannot be empty');
    }
    const stats = await this.describeIndex({ indexName });
    const resultIds = ids ?? vectors.map(() => crypto.randomUUID());
    if (resultIds.length !== vectors.length) {
      throw new Error('ids length must match vectors length');
    }
    if (metadata && metadata.length !== vectors.length) {
      throw new Error('metadata length must match vectors length');
    }
    const values: PgliteQueryValue[] = [];
    const rows: string[] = [];
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== stats.dimension) {
        throw new Error(
          `Vector at index ${index} has ${vector.length} dimensions, expected ${stats.dimension}`
        );
      }
      const base = index * 6;
      values.push(
        indexName,
        resultIds[index] ?? crypto.randomUUID(),
        vectorLiteral(vector),
        metadata?.[index] ? JSON.stringify(metadata[index]) : null,
        stats.dimension,
        stats.metric ?? DEFAULT_METRIC
      );
      rows.push(
        `($${base + 1}, $${base + 2}, $${base + 3}::vector, $${base + 4}::jsonb, $${base + 5}, $${base + 6}, now())`
      );
    }
    await this.database.query(
      `INSERT INTO ${MASTRA_VECTOR_TABLE}
        (index_name, id, embedding, metadata, dimension, metric, updated_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (index_name, id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        dimension = EXCLUDED.dimension,
        metric = EXCLUDED.metric,
        updated_at = now()`,
      values
    );
    this.emitRunEvent('memory.semantic.completed', 'Semantic memory indexed', {
      count: resultIds.length,
      indexName,
    });
    return resultIds;
  }

  override async query({
    indexName,
    queryVector,
    topK = DEFAULT_TOP_K,
    filter,
    includeVector,
  }: QueryVectorParams<PgliteVectorFilter>): Promise<QueryResult[]> {
    const stats = await this.describeIndex({ indexName });
    if (!Number.isSafeInteger(topK) || topK <= 0 || topK > MAX_TOP_K) {
      throw new Error(`topK must be between 1 and ${MAX_TOP_K}`);
    }
    if (queryVector && queryVector.length !== stats.dimension) {
      throw new Error(
        `Query vector has ${queryVector.length} dimensions, expected ${stats.dimension}`
      );
    }
    const values: PgliteQueryValue[] = [indexName, INDEX_METADATA_ID];
    const clauses = ['index_name = $1', 'id <> $2'];
    appendFilterSql(filter, values, clauses);
    let scoreSql = '1';
    let orderSql = 'updated_at DESC';
    if (queryVector) {
      values.push(vectorLiteral(queryVector));
      // For HNSW-indexable dimensions the distance expression and predicate must
      // mirror the partial index (halfvec cast + literal vector_dims match) or the
      // planner falls back to a sequential scan. The dimension is a validated safe
      // integer from the index metadata row, so inlining it is injection-safe —
      // and a literal (unlike a bind parameter) is guaranteed to imply the partial
      // index predicate. Score and order share one expression so returned scores
      // always agree with result ordering.
      const useHalfvec = stats.dimension <= MAX_HNSW_DIMENSION;
      const vectorParam = useHalfvec
        ? `$${values.length}::halfvec(${stats.dimension})`
        : `$${values.length}::vector`;
      const embeddingSql = useHalfvec ? `(embedding::halfvec(${stats.dimension}))` : 'embedding';
      if (useHalfvec) {
        clauses.push(`vector_dims(embedding) = ${stats.dimension}`);
      }
      const operator = VECTOR_OPERATORS[stats.metric ?? DEFAULT_METRIC];
      scoreSql =
        stats.metric === 'dotproduct'
          ? `-(${embeddingSql} ${operator} ${vectorParam})`
          : stats.metric === 'euclidean'
            ? `1 / (1 + (${embeddingSql} ${operator} ${vectorParam}))`
            : `1 - (${embeddingSql} ${operator} ${vectorParam})`;
      orderSql = `${embeddingSql} ${operator} ${vectorParam}`;
    }
    values.push(topK);
    const limitParam = `$${values.length}`;
    this.emitRunEvent('memory.semantic.started', 'Semantic memory search started', {
      indexName,
      topK,
    });
    const searchSql = `SELECT id, metadata, ${includeVector ? 'embedding::text' : 'NULL'} AS embedding,
        ${scoreSql} AS score
       FROM ${MASTRA_VECTOR_TABLE}
       WHERE ${clauses.join(' AND ')}
       ORDER BY ${orderSql}
       LIMIT ${limitParam}`;
    // Vector searches run inside a transaction so the filtered-HNSW tuning can
    // take effect (SET LOCAL is a no-op in autocommit). A handle without the
    // optional transaction capability (query-only test doubles) skips tuning —
    // the search stays correct, it just keeps pgvector's default window.
    const runInTransaction = queryVector ? this.database.transaction?.bind(this.database) : null;
    const result = runInTransaction
      ? await runInTransaction(async (tx) => {
          for (const statement of HNSW_SEARCH_TUNING_STATEMENTS) {
            await tx.query(statement);
          }
          return await tx.query<VectorRow>(searchSql, values);
        })
      : await this.database.query<VectorRow>(searchSql, values);
    const rows = result.rows.map((row) => {
      const queryResult: QueryResult = {
        id: row.id,
        score: Number(row.score),
      };
      const metadata = parseMetadata(row.metadata);
      if (metadata) {
        queryResult.metadata = metadata;
      }
      const parsedVector = parseVector(row.embedding);
      if (includeVector && parsedVector) {
        queryResult.vector = parsedVector;
      }
      return queryResult;
    });
    this.emitRunEvent('memory.semantic.completed', 'Semantic memory search completed', {
      count: rows.length,
      indexName,
      topK,
    });
    return rows;
  }

  override async updateVector({
    indexName,
    id,
    filter,
    update,
  }: UpdateVectorParams<PgliteVectorFilter>): Promise<void> {
    const stats = await this.describeIndex({ indexName });
    const setClauses: string[] = [];
    const values: PgliteQueryValue[] = [];
    if (update.vector) {
      if (update.vector.length !== stats.dimension) {
        throw new Error(
          `Updated vector has ${update.vector.length} dimensions, expected ${stats.dimension}`
        );
      }
      values.push(vectorLiteral(update.vector));
      setClauses.push(`embedding = $${values.length}::vector`);
    }
    if (update.metadata) {
      values.push(JSON.stringify(update.metadata));
      setClauses.push(`metadata = $${values.length}::jsonb`);
    }
    if (setClauses.length === 0) {
      return;
    }
    setClauses.push('updated_at = now()');
    values.push(indexName);
    const clauses = [`index_name = $${values.length}`];
    if (id) {
      values.push(id);
      clauses.push(`id = $${values.length}`);
    } else {
      appendFilterSql(filter, values, clauses);
    }
    await this.database.query(
      `UPDATE ${MASTRA_VECTOR_TABLE}
       SET ${setClauses.join(', ')}
       WHERE ${clauses.join(' AND ')}`,
      values
    );
  }

  override async deleteVector({ indexName, id }: DeleteVectorParams): Promise<void> {
    await this.deleteVectors({ ids: [id], indexName });
  }

  override async deleteVectors({
    indexName,
    ids,
    filter,
  }: DeleteVectorsParams<PgliteVectorFilter>): Promise<void> {
    await this.ensureVectorTable();
    if (ids && filter) {
      throw new Error('deleteVectors accepts either ids or filter, not both');
    }
    if (!(ids || filter)) {
      throw new Error('deleteVectors requires either ids or filter');
    }
    const values: PgliteQueryValue[] = [indexName];
    const clauses = ['index_name = $1'];
    if (ids) {
      values.push(ids);
      clauses.push(`id = ANY($${values.length}::text[])`);
    } else {
      appendFilterSql(filter, values, clauses);
    }
    await this.database.query(
      `DELETE FROM ${MASTRA_VECTOR_TABLE} WHERE ${clauses.join(' AND ')}`,
      values
    );
  }

  /**
   * Per-dimension partial halfvec HNSW index (mirrors the file_chunks technique in
   * packages/db). One dimensionless `embedding` column holds many dimensions, so a
   * global vector index is impossible; each (dimension, metric) pair gets its own
   * partial index keyed on `vector_dims(embedding)`. Dimensions above the halfvec
   * HNSW ceiling are skipped with a visible warning — queries stay correct via
   * sequential scan, they just lose ANN acceleration. Creation failures reject
   * loudly (no silent fallback); the failed key is cleared so a retry is possible.
   * The success memo is PER-INSTANCE: an index dropped externally after creation
   * is only recreated by a FRESH store's create/re-declare (the every-session
   * Mastra init path) — acceptable because nothing in the app drops these.
   */
  private async ensureDimensionIndex(
    dimension: number,
    metric: NonNullable<IndexStats['metric']>
  ): Promise<void> {
    const key = `${dimension}:${metric}`;
    const pending = this.dimensionIndexPromises.get(key);
    if (pending) {
      await pending;
      return;
    }
    const created = (async () => {
      if (dimension > MAX_HNSW_DIMENSION) {
        logger.warn('Skipping HNSW index for dimension above halfvec ceiling', {
          code: 'mastra_vector_dimension_index_skipped',
          dimension,
          maxDimension: MAX_HNSW_DIMENSION,
          metric,
        });
        return;
      }
      await this.database.query(
        `CREATE INDEX IF NOT EXISTS ${dimensionIndexName(dimension, metric)}
           ON ${MASTRA_VECTOR_TABLE}
           USING hnsw ((embedding::halfvec(${dimension})) ${HNSW_OPCLASSES[metric]})
           WHERE vector_dims(embedding) = ${dimension}`
      );
    })().catch((error: unknown) => {
      this.dimensionIndexPromises.delete(key);
      throw error;
    });
    this.dimensionIndexPromises.set(key, created);
    await created;
  }

  private async ensureVectorTable(): Promise<void> {
    this.initPromise ??= this.database
      .exec(MASTRA_VECTOR_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    await this.initPromise;
  }

  private async describeIndexIfExists(indexName: string): Promise<IndexStats | null> {
    await this.ensureVectorTable();
    const result = await this.database.query<IndexRow>(
      `SELECT index_name AS "indexName", dimension, metric,
        COUNT(*) FILTER (WHERE id <> $2) AS count
       FROM ${MASTRA_VECTOR_TABLE}
       WHERE index_name = $1
       GROUP BY index_name, dimension, metric`,
      [indexName, INDEX_METADATA_ID]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const dimension = Number(row.dimension);
    // The dimension is inlined into index DDL and query SQL (partial-index
    // matching requires a literal), so a corrupted metadata row must fail loudly
    // here rather than reach SQL construction.
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Error(
        `Vector index ${indexName} has an invalid stored dimension: ${String(row.dimension)}`
      );
    }
    return {
      count: Number(row.count),
      dimension,
      metric: row.metric ?? DEFAULT_METRIC,
    };
  }

  private emitRunEvent(
    kind: 'memory.semantic.completed' | 'memory.semantic.started',
    label: string,
    metadata: Record<string, string | number>
  ): void {
    emitAssistantRunEventSafely({
      event: {
        kind,
        label,
        metadata,
        status: kind.endsWith('.started') ? 'running' : 'completed',
      },
      eventSink: this.eventSink,
      onError: (error, event) => {
        logger.error('Assistant run event sink failed during vector operation', {
          code: 'assistant_run_event_sink_failed',
          error: getErrorMessage(error),
          kind: event.kind,
          runId: event.runId,
        });
      },
      runId: this.runId,
    });
  }
}
