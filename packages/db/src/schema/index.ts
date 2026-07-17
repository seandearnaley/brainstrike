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
  fromDriver(value: string): string {
    // Return raw tsvector string representation
    return value;
  },
  toDriver(value: string): string {
    // content_tsvector is a STORED generated column — never written from the app
    // (and `.generatedAlwaysAs` excludes it from insert types).
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
});

const textTimestamp = customType<{
  data: Date;
  driverData: string;
}>({
  dataType() {
    return 'text';
  },
  fromDriver(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`textTimestamp: invalid stored value "${value}"`);
    }
    return date;
  },
  toDriver(value: Date): string {
    return value.toISOString();
  },
});

export const textTimestampNow = sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// ROOTS TABLE
// ============================================================================

export const roots = pgTable('roots', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  displayName: text('display_name').notNull(),
  id: text('id').primaryKey().default(sql`(uuidv7()::text)`),
  kind: text('kind').$type<'path' | 'fsa' | 'snapshot' | 'legacy'>().notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  path: text('path'),
  status: text('status')
    .$type<'live' | 'needs-regrant' | 'disconnected' | 'snapshot-stale'>()
    .default('live')
    .notNull(),
});

// ============================================================================
// FILE RECORDS TABLE
// ============================================================================

export const fileRecords = pgTable(
  'file_records',
  {
    chunkingStrategy: text('chunking_strategy').$type<ResolvedChunkingStrategy>(),
    chunksCount: integer('chunks_count'),
    chunksProcessedAt: textTimestamp('chunks_processed_at'),
    content: text('content'),
    contentHash: text('content_hash'),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    embeddingSetId: text('embedding_set_id'),
    id: text('id').primaryKey(),
    // Nullable epoch-ms stat used by the background-sync stat-cache fast-path
    // (migration 037). BIGINT mirrors file_token_cache.mtime_ms. Null for rows
    // written before the column existed; self-heals on next write.
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    processedAt: textTimestamp('processed_at'),
    rootId: text('root_id').references(() => roots.id, { onDelete: 'cascade' }),
    size: integer('size').notNull(),
    tokenCount: integer('token_count'),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
  },
  (table) => [
    index('idx_file_records_path').on(table.path),
    index('idx_file_records_content_hash').on(table.contentHash),
    index('idx_file_records_embedding_set_id').on(table.embeddingSetId),
    index('idx_file_records_root_id').on(table.rootId),
  ]
);

// ============================================================================
// FILE CHUNKS TABLE
// ============================================================================

export const fileChunks = pgTable(
  'file_chunks',
  {
    chunkIndex: integer('chunk_index').notNull(),
    chunkSize: integer('chunk_size'),
    chunkType: text('chunk_type').$type<'text' | 'code' | 'sentence' | 'recursive'>(),
    content: text('content').notNull(),
    contentHash: text('content_hash'),
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
    // Flexible vector column (dimensions determined at runtime)
    embedding: vector('embedding'),
    embeddingHash: text('embedding_hash'),
    embeddingSetId: text('embedding_set_id'),
    embeddingUpdatedAt: textTimestamp('embedding_updated_at'),
    endLine: integer('end_line'),
    endOffset: integer('end_offset'),
    fileRecordId: text('file_record_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    id: text('id').primaryKey(),
    startLine: integer('start_line'),
    startOffset: integer('start_offset'),
    tokenCount: integer('token_count'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
  },
  (table) => [index('idx_selection_snapshots_created_at').on(table.createdAt)]
);

export const selectionSnapshotFiles = pgTable(
  'selection_snapshot_files',
  {
    filePath: text('file_path').notNull(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => selectionSnapshots.id, { onDelete: 'cascade' }),
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
  allowDuplicates: boolean('allow_duplicates').default(false),
  category: text('category'),
  createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
  description: text('description'),
  dimensions: integer('dimensions').notNull(),
  distance: text('distance').$type<'cosine' | 'l2' | 'ip'>().default('cosine'),
  id: text('id').primaryKey(),
  modelId: text('model_id').notNull(),
  modelKey: text('model_key').notNull(),
  name: text('name'),
  systemRole: text('system_role').$type<'workspace-index'>(),
  tags: text('tags'),
});

// ============================================================================
// PROMPT WORKBENCH TABLES
// ============================================================================

export const promptEmbeddingProfiles = pgTable('prompt_embedding_profiles', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  dimensions: integer('dimensions').notNull(),
  distance: text('distance').$type<'cosine' | 'l2' | 'ip'>().default('cosine').notNull(),
  id: text('id').primaryKey(),
  modelId: text('model_id').notNull(),
  modelKey: text('model_key').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const promptItems = pgTable(
  'prompt_items',
  {
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    description: text('description'),
    embedding: vector('embedding'),
    embeddingError: text('embedding_error'),
    embeddingProfileId: text('embedding_profile_id').references(() => promptEmbeddingProfiles.id, {
      onDelete: 'set null',
    }),
    embeddingRevision: integer('embedding_revision'),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
    id: text('id').primaryKey(),
    isFavorite: boolean('is_favorite').default(false).notNull(),
    kind: text('kind').$type<'prompt' | 'snippet' | 'fragment'>().notNull(),
    lastUsedAction: text('last_used_action').$type<'compose' | 'insert' | 'new-thread'>(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    modelKey: text('model_key'),
    modelSettings: jsonb('model_settings').$type<Record<string, unknown>>(),
    rating: integer('rating'),
    revision: integer('revision').default(1).notNull(),
    sourceUrl: text('source_url'),
    tags: jsonb('tags').$type<string[]>().default([]).notNull(),
    title: text('title').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    useCount: integer('use_count').default(0).notNull(),
  },
  (table) => [
    index('idx_prompt_items_kind_updated_at').on(table.kind, table.updatedAt),
    index('idx_prompt_items_embedding_profile_id').on(table.embeddingProfileId),
  ]
);

export const promptItemRevisions = pgTable(
  'prompt_item_revisions',
  {
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    description: text('description'),
    id: text('id').primaryKey(),
    modelKey: text('model_key'),
    modelSettings: jsonb('model_settings').$type<Record<string, unknown>>(),
    note: text('note'),
    promptItemId: text('prompt_item_id')
      .notNull()
      .references(() => promptItems.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    tags: jsonb('tags').$type<string[]>().default([]).notNull(),
    title: text('title').notNull(),
  },
  (table) => [
    uniqueIndex('idx_prompt_item_revisions_unique').on(table.promptItemId, table.revision),
    index('idx_prompt_item_revisions_item_revision').on(table.promptItemId, table.revision),
  ]
);

export const collectionIndexingStats = pgTable(
  'collection_indexing_stats',
  {
    chunkCount: integer('chunk_count').default(0).notNull(),
    dirty: boolean('dirty').default(false).notNull(),
    embeddedChunkCount: integer('embedded_chunk_count').default(0).notNull(),
    embeddingSetId: text('embedding_set_id').primaryKey(),
    fileCount: integer('file_count').default(0).notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).defaultNow().notNull(),
    pendingChunkCount: integer('pending_chunk_count').default(0).notNull(),
  },
  (table) => [index('idx_collection_indexing_stats_dirty').on(table.dirty, table.lastRefreshedAt)]
);

// ============================================================================
// JOB QUEUE TABLE
// ============================================================================

export const jobQueue = pgTable(
  'job_queue',
  {
    attempts: integer('attempts').default(0).notNull(),
    backoffMs: integer('backoff_ms').default(0).notNull(),
    chunkId: text('chunk_id'),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    dedupeKey: text('dedupe_key'),
    embeddingSetId: text('embedding_set_id'),
    error: text('error'),
    id: text('id').primaryKey(),
    jobType: text('job_type').notNull(),
    leasedUntil: textTimestamp('leased_until'),
    leaseToken: text('lease_token'),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    payload: jsonb('payload').$type<unknown>(),
    queue: text('queue').notNull(),
    runAt: textTimestamp('run_at').default(textTimestampNow).notNull(),
    state: text('state')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'>()
      .default('queued')
      .notNull(),
    updatedAt: textTimestamp('updated_at').default(textTimestampNow).notNull(),
    workerId: text('worker_id'),
  },
  (table) => [
    index('idx_job_queue_state_run_at').on(table.state, table.runAt),
    index('idx_job_queue_dedupe_key').on(table.dedupeKey),
    index('idx_job_queue_leased_until').on(table.leasedUntil),
    index('idx_job_queue_active_embed_chunk_id')
      .on(table.chunkId)
      .where(
        sql`${table.jobType} = 'embed_chunk' AND ${table.chunkId} IS NOT NULL AND ${table.state} IN ('queued','running')`
      ),
    index('idx_job_queue_embed_set_state')
      .on(table.queue, table.jobType, table.embeddingSetId, table.state, table.updatedAt)
      .where(sql`${table.jobType} = 'embed_chunk' AND ${table.embeddingSetId} IS NOT NULL`),
  ]
);

// ============================================================================
// TOKEN CACHE TABLE (simple cache)
// ============================================================================

export const tokenCache = pgTable(
  'token_cache',
  {
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    filePath: text('file_path').notNull(),
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    tokenCount: integer('token_count').notNull(),
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
    contentHash: text('content_hash').notNull(),
    countingMode: text('counting_mode').$type<'accurate' | 'heuristic'>().notNull(),
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    filePath: text('file_path').notNull(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    folderId: text('folder_id').notNull(),
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    modelEncoding: text('model_encoding'),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    tokenCount: integer('token_count').notNull(),
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
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    fileId: text('file_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    id: text('id').primaryKey(),
    tag: text('tag').notNull(),
  },
  (table) => [
    uniqueIndex('idx_file_tags_unique').on(table.fileId, table.tag),
    index('idx_file_tags_tag').on(table.tag),
  ]
);

export const fileRelationships = pgTable(
  'file_relationships',
  {
    createdAt: textTimestamp('created_at').default(textTimestampNow).notNull(),
    id: text('id').primaryKey(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    relationshipType: text('relationship_type').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
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
    /** Access count for cache analytics */
    accessCount: integer('access_count').default(1).notNull(),
    /** When this cache entry was last accessed (for LRU eviction) */
    accessedAt: timestamp('accessed_at', { withTimezone: true }).defaultNow().notNull(),
    /** SHA-256 hash of the content */
    contentHash: text('content_hash').notNull(),
    /** When this cache entry was created */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Embedding dimension (for validation) */
    dimensions: integer('dimensions').notNull(),
    /** The cached embedding vector */
    embedding: vector('embedding').notNull(),
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    /** Composite model key (e.g., "local::all-MiniLM-L6-v2" or "openai::text-embedding-3-small") */
    modelKey: text('model_key').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    icon: text('icon'),
    id: text('id').primaryKey(),
    isEnabled: boolean('is_enabled').default(false).notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_providers_sort_order').on(table.sortOrder)]
);

export const models = pgTable(
  'models',
  {
    bestFor: jsonb('best_for').$type<readonly string[] | null>(),
    capabilities: jsonb('capabilities').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    description: text('description'),
    icon: text('icon'),
    id: text('id').primaryKey(),
    isEnabled: boolean('is_enabled').default(false).notNull(),
    name: text('name').notNull(),
    parameters: jsonb('parameters').$type<Record<string, unknown> | null>(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    tagline: text('tagline'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    description: text('description'),
    /** Exclude patterns (glob or regex based on useRegex) */
    excludes: text('excludes').array().notNull().default([]),
    /** Lucide icon name (e.g., 'file-code', 'settings', 'folder-open') */
    icon: text('icon').notNull().default('file'),
    // uuidv7() (Postgres 18): time-sortable ids; see migration 035.
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    /** Include patterns (glob or regex based on useRegex) */
    includes: text('includes').array().notNull().default([]),
    /** Whether this is a built-in default preset */
    isDefault: boolean('is_default').notNull().default(false),
    name: text('name').notNull(),
    /** Sort order for display */
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /** Whether patterns are regex (true) or glob (false) */
    useRegex: boolean('use_regex').notNull().default(false),
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

export type Root = typeof roots.$inferSelect;
export type NewRoot = typeof roots.$inferInsert;
