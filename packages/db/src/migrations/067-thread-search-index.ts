import type { Migration } from './migration-runner';

/**
 * Migration 067: hybrid search index for assistant threads.
 *
 * Brainstrike-owned sister tables to the thread groups/placements family
 * (054/056/059): searchable message text is Brainstrike-owned derived state
 * while `mastra_messages`/`mastra_threads` stay Mastra-owned, so this table
 * deliberately has NO FKs to the Mastra tables (the numbered runner also
 * executes against a bare schema where they may not exist yet). Rows are
 * joined by id at query time; an orphaned row is inert and swept by the
 * repository's bounded GC.
 *
 * - `content_text` is the bounded plain text extracted from the Mastra v2
 *   content JSONB (text parts only); `content_hash` is md5 of the RAW content
 *   JSONB so the sync upsert can detect any source change and reset the
 *   embedding to pending (CAS via `IS DISTINCT FROM`).
 * - `content_tsvector` is a STORED generated column (034 precedent): the
 *   lexical arm can never drift from `content_text`.
 * - `brainstrike_thread_search_profiles` mirrors `prompt_embedding_profiles`
 *   (051): a singleton renderer-local embedding profile, kept separate from
 *   both the prompt profile and the file-collection `embedding_sets`
 *   lifecycle so each feature's index can evolve independently.
 * - `brainstrike_thread_search_state` tracks refresh progress PER THREAD
 *   (`last_activity_at` = the `mastra_threads."updatedAt"` value through
 *   which that thread's messages were last re-extracted). A single global
 *   watermark would permanently skip a thread whose final same-id content
 *   save does not advance its own `updatedAt` once other threads push the
 *   global maximum past it.
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner (numbered
 * runner for tests, drizzle customMigrations for the real app) creates tables
 * on different paths.
 */
export const migration067ThreadSearchIndex: Migration = {
  down: `
    DROP TABLE IF EXISTS brainstrike_thread_message_index;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_thread_search_state;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_thread_search_profiles;
  `,
  ledgerKey: 'custom-067-thread-search-index',
  name: 'thread_search_index',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_thread_search_profiles (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      model_key TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      distance TEXT NOT NULL DEFAULT 'cosine',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT thread_search_profiles_singleton_check CHECK (id = 'default'),
      CONSTRAINT thread_search_profiles_dimensions_check CHECK (dimensions > 0),
      CONSTRAINT thread_search_profiles_distance_check CHECK (distance IN ('cosine', 'l2', 'ip'))
    );
    --> statement-breakpoint

    INSERT INTO brainstrike_thread_search_profiles (
      id, model_id, model_key, dimensions, distance
    ) VALUES (
      'default',
      'Xenova/all-MiniLM-L6-v2',
      'local::Xenova/all-MiniLM-L6-v2',
      384,
      'cosine'
    )
    ON CONFLICT (id) DO UPDATE SET
      model_id = EXCLUDED.model_id,
      model_key = EXCLUDED.model_key,
      dimensions = EXCLUDED.dimensions,
      distance = EXCLUDED.distance,
      updated_at = CURRENT_TIMESTAMP;
    --> statement-breakpoint

    CREATE TABLE IF NOT EXISTS brainstrike_thread_message_index (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      content_tsvector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', content_text)
      ) STORED,
      message_created_at TIMESTAMPTZ NOT NULL,
      embedding VECTOR(384),
      embedding_profile_id TEXT REFERENCES brainstrike_thread_search_profiles(id) ON DELETE SET NULL,
      embedding_error TEXT,
      embedding_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_thread_message_index_tsvector
      ON brainstrike_thread_message_index USING gin(content_tsvector);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_thread_message_index_thread_created
      ON brainstrike_thread_message_index (thread_id, message_created_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_thread_message_index_resource
      ON brainstrike_thread_message_index (resource_id);
    --> statement-breakpoint
    -- Partial index for the embedding backlog scan: only rows with real text
    -- and neither a stored vector nor a recorded failure are candidates.
    CREATE INDEX IF NOT EXISTS idx_thread_message_index_pending_embedding
      ON brainstrike_thread_message_index (resource_id, message_created_at DESC)
      WHERE embedding IS NULL AND embedding_error IS NULL AND content_text <> '';
    --> statement-breakpoint
    -- ANN index for the semantic arm (embedded rows only). The dimension is
    -- fixed by the singleton profile (384); a future profile dimension change
    -- is a migration that rebuilds the column + index together.
    CREATE INDEX IF NOT EXISTS idx_thread_message_index_embedding_hnsw
      ON brainstrike_thread_message_index USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL;
    --> statement-breakpoint
    -- Errored rows only, keyed by attempt time: makes the aged-error revive
    -- scan indexed + bounded (cheap even when zero rows have errored) so a
    -- transient embed failure can be retried without a full-table scan.
    CREATE INDEX IF NOT EXISTS idx_thread_message_index_errored_embedding
      ON brainstrike_thread_message_index (embedding_updated_at)
      WHERE embedding_error IS NOT NULL;
    --> statement-breakpoint

    CREATE TABLE IF NOT EXISTS brainstrike_thread_search_state (
      thread_id TEXT PRIMARY KEY,
      last_activity_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `,
  version: 67,
};
