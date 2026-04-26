import type { Migration } from './migration-runner';

export const migration030CollectionIndexingStats: Migration = {
  version: 30,
  name: 'collection_indexing_stats',
  up: `
    CREATE TABLE IF NOT EXISTS collection_indexing_stats (
      embedding_set_id TEXT PRIMARY KEY,
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedded_chunk_count INTEGER NOT NULL DEFAULT 0,
      pending_chunk_count INTEGER NOT NULL DEFAULT 0,
      dirty BOOLEAN NOT NULL DEFAULT FALSE,
      last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO collection_indexing_stats (
      embedding_set_id,
      file_count,
      chunk_count,
      embedded_chunk_count,
      pending_chunk_count,
      dirty,
      last_refreshed_at
    )
    SELECT
      s.id,
      (
        SELECT COUNT(*)::int
          FROM file_records fr
         WHERE fr.embedding_set_id = s.id
      ) AS file_count,
      (
        SELECT COUNT(*)::int
          FROM file_chunks c
         WHERE c.embedding_set_id = s.id
      ) AS chunk_count,
      (
        SELECT COUNT(*)::int
          FROM file_chunks c
         WHERE c.embedding_set_id = s.id
           AND c.embedding IS NOT NULL
      ) AS embedded_chunk_count,
      (
        SELECT COUNT(*)::int
          FROM file_chunks c
         WHERE c.embedding_set_id = s.id
           AND c.embedding IS NULL
      ) AS pending_chunk_count,
      FALSE,
      NOW()
    FROM embedding_sets s
    ON CONFLICT (embedding_set_id) DO UPDATE SET
      file_count = EXCLUDED.file_count,
      chunk_count = EXCLUDED.chunk_count,
      embedded_chunk_count = EXCLUDED.embedded_chunk_count,
      pending_chunk_count = EXCLUDED.pending_chunk_count,
      dirty = FALSE,
      last_refreshed_at = EXCLUDED.last_refreshed_at;

    CREATE INDEX IF NOT EXISTS idx_collection_indexing_stats_dirty
      ON collection_indexing_stats(dirty, last_refreshed_at);
  `,
  down: `
    DROP INDEX IF EXISTS idx_collection_indexing_stats_dirty;
    DROP TABLE IF EXISTS collection_indexing_stats;
  `,
};
