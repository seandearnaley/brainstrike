/**
 * Production-canonical Drizzle schema for Brainstrike's local PGlite database.
 *
 * Runtime migrations, repository types, and compatibility audits derive their
 * table contracts from this module for both browser and Electron contexts.
 */

import type { ResolvedChunkingStrategy } from '@brainstrike/indexing-contract';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Custom type for PostgreSQL tsvector (full-text search)
 *
 * The `content_tsvector` column is a STORED generated column (migration 034) that
 * Postgres computes from `content` — it is never written by the application. This
 * type provides read-only access for queries.
 *
 * Usage in queries:
 * - WHERE content_tsvector @@ to_tsquery('english', 'search & terms')
 * - ts_rank(content_tsvector, query) for ranking
 */
const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'tsvector';
  },
  toDriver(value: string): string {
    // content_tsvector is a STORED generated column — never written from the app
    // (and `.generatedAlwaysAs` excludes it from insert types).
    return value;
  },
  fromDriver(value: string): string {
    // Return raw tsvector string representation
    return value;
  },
});

/**
 * Custom type for pgvector - flexible dimensions
 *
 * Includes validation in toDriver to prevent invalid vector values
 * (NaN, Infinity, -Infinity) from being stored in the database.
 */
const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions?: number };
}>({
  dataType(config) {
    if (config?.dimensions) {
      return `vector(${config.dimensions})`;
    }
    return 'vector';
  },
  toDriver(value: number[]): string {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('Vector must be a non-empty array of numbers');
    }
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(
          `Invalid vector value at index ${i}: ${v} (must be a finite number, got ${typeof v})`
        );
      }
    }
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // Handle pgvector format: "[0.1,0.2,0.3]"
    const cleaned = value.replace(/[[\]()]/g, '');
    const parsed = cleaned.split(',').map(Number);
    // Validate parsed values - reject if any are NaN
    for (let i = 0; i < parsed.length; i++) {
      if (!Number.isFinite(parsed[i])) {
        throw new Error(`Invalid vector value from database at index ${i}: ${parsed[i]}`);
      }
    }
    return parsed;
  },
});

const textTimestamp = customType<{
  data: Date;
  driverData: string;
}>({
  dataType() {
    return 'text';
  },
  toDriver(value: Date): string {
    return value.toISOString();
  },
  fromDriver(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`textTimestamp: invalid stored value "${value}"`);
    }
    return date;
  },
});

export const textTimestampNow = sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// FILE RECORDS TABLE
// ============================================================================

export const fileRecords = pgTable(
  'file_records',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    sourceRootPath: text('source_root_path'),
    size: integer('size').notNull(),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
    content: text('content'),
    contentHash: text('content_hash'),
    tokenCount: integer('token_count'),
    processedAt: textTimestamp('processed_at'),
    embeddingSetId: text('embedding_set_id'),
    chunksProcessedAt: textTimestamp('chunks_processed_at'),
    chunksCount: integer('chunks_count'),
    chunkingStrategy: text('chunking_strategy').$type<ResolvedChunkingStrategy>(),
  },
  (table) => [
    index('idx_file_records_path').on(table.path),
    index('idx_file_records_source_root_path').on(table.sourceRootPath),
    index('idx_file_records_content_hash').on(table.contentHash),
    index('idx_file_records_embedding_set_id').on(table.embeddingSetId),
  ]
);

// ============================================================================
// FILE CHUNKS TABLE
// ============================================================================

export const fileChunks = pgTable(
  'file_chunks',
  {
    id: text('id').primaryKey(),
    fileRecordId: text('file_record_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash'),
    tokenCount: integer('token_count'),
    chunkType: text('chunk_type').$type<'text' | 'code' | 'sentence' | 'recursive'>(),
    chunkSize: integer('chunk_size'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    // Flexible vector column (dimensions determined at runtime)
    embedding: vector('embedding'),
    embeddingSetId: text('embedding_set_id'),
    embeddingUpdatedAt: textTimestamp('embedding_updated_at'),
    embeddingHash: text('embedding_hash'),
    // Full-text search tsvector — a STORED generated column (migration 034) computed
    // by Postgres from `content`. Declared generated so the Drizzle type matches the
    // DB: a `.values({ contentTsvector })` write is now a compile error instead of a
    // runtime "cannot insert into generated column" failure. GIN-indexed for fast
    // ts_query lookups.
    //
    // SNAPSHOT DRIFT (intentional): the committed drizzle manifest/snapshots
    // (`src/drizzle/migrations.json`, `drizzle/meta/*_snapshot.json`) still describe
    // this as a PLAIN tsvector column with no GIN index. The real DDL is owned by
    // custom migration 034, which runs AFTER the manifest (see `runMigrations`) and
    // converts it to STORED-generated + adds the GIN index. Do NOT `drizzle-kit
    // generate` to "fix" the drift — this repo's snapshots have already diverged for
    // other reasons (see CLAUDE.md migration-architecture note), so regenerating would
    // emit a spurious `ALTER COLUMN ... SET GENERATED`/index migration plus unrelated
    // churn. Schema changes go in a numbered migration + the customMigrations ledger.
    contentTsvector: tsvector('content_tsvector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(content, ''))`
    ),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    index('idx_file_chunks_file_record_id').on(table.fileRecordId),
    index('idx_file_chunks_embedding_set_id').on(table.embeddingSetId),
    index('idx_file_chunks_content_hash').on(table.contentHash),
    // Note: GIN index on content_tsvector is created via migration, not Drizzle
    // because Drizzle doesn't support GIN index type directly
  ]
);

// ============================================================================
// SELECTION SNAPSHOTS TABLES
// ============================================================================

export const selectionSnapshots = pgTable(
  'selection_snapshots',
  {
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [index('idx_selection_snapshots_created_at').on(table.createdAt)]
);

export const selectionSnapshotFiles = pgTable(
  'selection_snapshot_files',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => selectionSnapshots.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
  },
  (table) => [
    index('idx_selection_snapshot_files_snapshot_id').on(table.snapshotId),
    index('idx_selection_snapshot_files_file_path').on(table.filePath),
    uniqueIndex('idx_selection_snapshot_files_unique').on(table.snapshotId, table.filePath),
  ]
);

// ============================================================================
// EMBEDDING SETS TABLE
// ============================================================================

export const embeddingSets = pgTable('embedding_sets', {
  id: text('id').primaryKey(),
  modelKey: text('model_key').notNull(),
  modelId: text('model_id').notNull(),
  dimensions: integer('dimensions').notNull(),
  distance: text('distance').$type<'cosine' | 'l2' | 'ip'>().default('cosine'),
  createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
  name: text('name'),
  description: text('description'),
  tags: text('tags'),
  category: text('category'),
  allowDuplicates: boolean('allow_duplicates').default(false),
});

export const collectionIndexingStats = pgTable(
  'collection_indexing_stats',
  {
    embeddingSetId: text('embedding_set_id').primaryKey(),
    fileCount: integer('file_count').default(0).notNull(),
    chunkCount: integer('chunk_count').default(0).notNull(),
    embeddedChunkCount: integer('embedded_chunk_count').default(0).notNull(),
    pendingChunkCount: integer('pending_chunk_count').default(0).notNull(),
    dirty: boolean('dirty').default(false).notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_collection_indexing_stats_dirty').on(table.dirty, table.lastRefreshedAt)]
);

// ============================================================================
// JOB QUEUE TABLE
// ============================================================================

export const jobQueue = pgTable(
  'job_queue',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').$type<unknown>(),
    state: text('state')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'>()
      .default('queued')
      .notNull(),
    runAt: textTimestamp('run_at').default(textTimestampNow).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    backoffMs: integer('backoff_ms').default(0).notNull(),
    leaseToken: text('lease_token'),
    leasedUntil: textTimestamp('leased_until'),
    workerId: text('worker_id'),
    dedupeKey: text('dedupe_key'),
    error: text('error'),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    index('idx_job_queue_state_run_at').on(table.state, table.runAt),
    index('idx_job_queue_dedupe_key').on(table.dedupeKey),
    index('idx_job_queue_leased_until').on(table.leasedUntil),
  ]
);

// ============================================================================
// TOKEN CACHE TABLE (simple cache)
// ============================================================================

export const tokenCache = pgTable(
  'token_cache',
  {
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    filePath: text('file_path').notNull(),
    contentHash: text('content_hash').notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_token_cache_file_path').on(table.filePath),
    index('idx_token_cache_content_hash').on(table.contentHash),
  ]
);

// ============================================================================
// FILE TOKEN CACHE TABLE (folder-based cache with counting modes)
// ============================================================================

export const fileTokenCache = pgTable(
  'file_token_cache',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    folderId: text('folder_id').notNull(),
    filePath: text('file_path').notNull(),
    contentHash: text('content_hash').notNull(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    tokenCount: integer('token_count').notNull(),
    countingMode: text('counting_mode').$type<'accurate' | 'heuristic'>().notNull(),
    modelEncoding: text('model_encoding'),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    uniqueIndex('idx_file_token_cache_folder_path_unique').on(table.folderId, table.filePath),
    index('idx_file_token_cache_lookup').on(table.folderId, table.filePath),
    index('idx_file_token_cache_hash').on(table.contentHash),
    index('idx_file_token_cache_folder').on(table.folderId),
    index('idx_file_token_cache_mode').on(table.folderId, table.countingMode),
  ]
);

export const fileTags = pgTable(
  'file_tags',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    uniqueIndex('idx_file_tags_unique').on(table.fileId, table.tag),
    index('idx_file_tags_tag').on(table.tag),
  ]
);

export const fileRelationships = pgTable(
  'file_relationships',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    relationshipType: text('relationship_type').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    uniqueIndex('idx_file_relationships_unique').on(
      table.sourceId,
      table.targetId,
      table.relationshipType
    ),
    index('idx_file_relationships_source').on(table.sourceId),
    index('idx_file_relationships_target').on(table.targetId),
    index('idx_file_relationships_type').on(table.relationshipType),
  ]
);

// ============================================================================
// EMBEDDING CACHE TABLE (BST-170)
// ============================================================================

/**
 * Content-level embedding cache.
 *
 * This table caches embeddings keyed by (contentHash, modelKey) to avoid
 * re-computing embeddings when identical content appears in multiple chunks.
 *
 * The cache is model-specific because different models produce different
 * embeddings for the same content.
 */
export const embeddingCache = pgTable(
  'embedding_cache',
  {
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    /** SHA-256 hash of the content */
    contentHash: text('content_hash').notNull(),
    /** Composite model key (e.g., "local::all-MiniLM-L6-v2" or "openai::text-embedding-3-small") */
    modelKey: text('model_key').notNull(),
    /** The cached embedding vector */
    embedding: vector('embedding').notNull(),
    /** Embedding dimension (for validation) */
    dimensions: integer('dimensions').notNull(),
    /** When this cache entry was created */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When this cache entry was last accessed (for LRU eviction) */
    accessedAt: timestamp('accessed_at', { withTimezone: true }).defaultNow().notNull(),
    /** Access count for cache analytics */
    accessCount: integer('access_count').default(1).notNull(),
  },
  (table) => [
    // Unique constraint on (contentHash, modelKey) - the cache key
    uniqueIndex('idx_embedding_cache_content_model').on(table.contentHash, table.modelKey),
    // Index for contentHash lookups
    index('idx_embedding_cache_content_hash').on(table.contentHash),
    // Index for cache eviction queries (oldest accessed first)
    index('idx_embedding_cache_accessed_at').on(table.accessedAt),
  ]
);

// ============================================================================
// PROVIDER AND MODEL CATALOG TABLES
// ============================================================================

export const providers = pgTable(
  'providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    isEnabled: boolean('is_enabled').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_providers_sort_order').on(table.sortOrder)]
);

export const models = pgTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    tagline: text('tagline'),
    bestFor: jsonb('best_for').$type<readonly string[] | null>(),
    icon: text('icon'),
    isEnabled: boolean('is_enabled').default(false).notNull(),
    capabilities: jsonb('capabilities').$type<Record<string, unknown> | null>(),
    parameters: jsonb('parameters').$type<Record<string, unknown> | null>(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_models_provider_id').on(table.providerId),
    index('idx_models_sort_order').on(table.sortOrder),
  ]
);

// ============================================================================
// VIEW FILTER PRESETS TABLE
// ============================================================================

/**
 * View filter presets for file explorer.
 *
 * Stores user-defined and default presets for file filtering,
 * including include/exclude patterns with optional regex support.
 */
export const viewFilterPresets = pgTable(
  'view_filter_presets',
  {
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** Lucide icon name (e.g., 'file-code', 'settings', 'folder-open') */
    icon: text('icon').notNull().default('file'),
    /** Include patterns (glob or regex based on useRegex) */
    includes: text('includes').array().notNull().default([]),
    /** Exclude patterns (glob or regex based on useRegex) */
    excludes: text('excludes').array().notNull().default([]),
    /** Whether patterns are regex (true) or glob (false) */
    useRegex: boolean('use_regex').notNull().default(false),
    /** Whether this is a built-in default preset */
    isDefault: boolean('is_default').notNull().default(false),
    /** Sort order for display */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_view_filter_presets_sort_order').on(table.sortOrder),
    index('idx_view_filter_presets_is_default').on(table.isDefault),
  ]
);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ViewFilterPreset = typeof viewFilterPresets.$inferSelect;
export type NewViewFilterPreset = typeof viewFilterPresets.$inferInsert;

export type FileRecord = typeof fileRecords.$inferSelect;
export type NewFileRecord = typeof fileRecords.$inferInsert;

export type FileChunk = typeof fileChunks.$inferSelect;
export type NewFileChunk = typeof fileChunks.$inferInsert;

export type SelectionSnapshot = typeof selectionSnapshots.$inferSelect;
export type NewSelectionSnapshot = typeof selectionSnapshots.$inferInsert;

export type SelectionSnapshotFile = typeof selectionSnapshotFiles.$inferSelect;
export type NewSelectionSnapshotFile = typeof selectionSnapshotFiles.$inferInsert;

export type EmbeddingSet = typeof embeddingSets.$inferSelect;
export type NewEmbeddingSet = typeof embeddingSets.$inferInsert;

export type Job = typeof jobQueue.$inferSelect;
export type NewJob = typeof jobQueue.$inferInsert;

export type TokenCacheEntry = typeof tokenCache.$inferSelect;
export type NewTokenCacheEntry = typeof tokenCache.$inferInsert;

export type FileTokenCacheEntry = typeof fileTokenCache.$inferSelect;
export type NewFileTokenCacheEntry = typeof fileTokenCache.$inferInsert;

export type FileTag = typeof fileTags.$inferSelect;
export type NewFileTag = typeof fileTags.$inferInsert;

export type FileRelationship = typeof fileRelationships.$inferSelect;
export type NewFileRelationship = typeof fileRelationships.$inferInsert;

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;

export type EmbeddingCacheEntry = typeof embeddingCache.$inferSelect;
export type NewEmbeddingCacheEntry = typeof embeddingCache.$inferInsert;
