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
      const vectorParam = `$${values.length}::vector`;
      const operator = VECTOR_OPERATORS[stats.metric ?? DEFAULT_METRIC];
      scoreSql =
        stats.metric === 'dotproduct'
          ? `-(embedding ${operator} ${vectorParam})`
          : stats.metric === 'euclidean'
            ? `1 / (1 + (embedding ${operator} ${vectorParam}))`
            : `1 - (embedding ${operator} ${vectorParam})`;
      orderSql = `embedding ${operator} ${vectorParam}`;
    }
    values.push(topK);
    const limitParam = `$${values.length}`;
    this.emitRunEvent('memory.semantic.started', 'Semantic memory search started', {
      indexName,
      topK,
    });
    const result = await this.database.query<VectorRow>(
      `SELECT id, metadata, ${includeVector ? 'embedding::text' : 'NULL'} AS embedding,
        ${scoreSql} AS score
       FROM ${MASTRA_VECTOR_TABLE}
       WHERE ${clauses.join(' AND ')}
       ORDER BY ${orderSql}
       LIMIT ${limitParam}`,
      values
    );
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
    await this.deleteVectors({ indexName, ids: [id] });
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
    return {
      count: Number(row.count),
      dimension: Number(row.dimension),
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
