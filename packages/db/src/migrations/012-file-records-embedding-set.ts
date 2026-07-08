import type { Migration } from './migration-runner';

// Migration 012: Add embedding_set_id to file_records
// Files belong to collections, not chunks
// This associates an imported file with a specific collection at import time

export const migration012FileRecordsEmbeddingSet: Migration = {
  down: `
    -- Drop index
    DROP INDEX IF EXISTS idx_file_records_embedding_set;

    -- Remove column from file_records
    ALTER TABLE file_records
      DROP COLUMN IF EXISTS embedding_set_id;
  `,
  name: 'file_records_embedding_set',
  up: `
    -- Add embedding_set_id to file_records
    ALTER TABLE file_records
      ADD COLUMN IF NOT EXISTS embedding_set_id TEXT;

    -- Add index for fast collection-based queries
    CREATE INDEX IF NOT EXISTS idx_file_records_embedding_set ON file_records(embedding_set_id);

    -- Migrate existing data: if a file's chunks all have the same embedding_set_id, set it on the file
    -- Only attempt this if file_chunks table exists
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'file_chunks') THEN
        UPDATE file_records
        SET embedding_set_id = (
          SELECT c.embedding_set_id
          FROM file_chunks c
          WHERE c.file_record_id = file_records.id
            AND c.embedding_set_id IS NOT NULL
          GROUP BY c.embedding_set_id
          HAVING COUNT(DISTINCT c.embedding_set_id) = 1
          LIMIT 1
        )
        WHERE embedding_set_id IS NULL
          AND EXISTS (
            SELECT 1 FROM file_chunks c
            WHERE c.file_record_id = file_records.id
              AND c.embedding_set_id IS NOT NULL
          );
      END IF;
    END $$;
  `,
  version: 12,
};
