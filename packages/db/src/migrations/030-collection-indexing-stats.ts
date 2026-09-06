import type { Migration } from './migration-runner';

export const migration030CollectionIndexingStats: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_collection_indexing_stats_dirty;
    --> statement-breakpoint
    DROP TABLE IF EXISTS collection_indexing_stats;
  `,
  ledgerKey: 'custom-030-collection-indexing-stats',
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
    --> statement-breakpoint

    WITH aggregated_files AS (
      SELECT
        embedding_set_id::text AS embedding_set_id,
        COUNT(*)::int AS file_count
      FROM file_records
      GROUP BY embedding_set_id::text
    ),
    aggregated_chunks AS (
      SELECT
        embedding_set_id::text AS embedding_set_id,
        COUNT(*)::int AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NULL)::int AS pending_chunk_count
      FROM file_chunks
      GROUP BY embedding_set_id::text
    )
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
      COALESCE(af.file_count, 0) AS file_count,
      COALESCE(ac.chunk_count, 0) AS chunk_count,
      COALESCE(ac.embedded_chunk_count, 0) AS embedded_chunk_count,
      COALESCE(ac.pending_chunk_count, 0) AS pending_chunk_count,
      FALSE,
      NOW()
    FROM embedding_sets s
    LEFT JOIN aggregated_files af ON af.embedding_set_id = s.id::text
    LEFT JOIN aggregated_chunks ac ON ac.embedding_set_id = s.id::text
    ON CONFLICT (embedding_set_id) DO UPDATE SET
      file_count = EXCLUDED.file_count,
      chunk_count = EXCLUDED.chunk_count,
      embedded_chunk_count = EXCLUDED.embedded_chunk_count,
      pending_chunk_count = EXCLUDED.pending_chunk_count,
      dirty = FALSE,
      last_refreshed_at = EXCLUDED.last_refreshed_at;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_collection_indexing_stats_dirty
      ON collection_indexing_stats(dirty, last_refreshed_at);
  `,
  version: 30,
};
