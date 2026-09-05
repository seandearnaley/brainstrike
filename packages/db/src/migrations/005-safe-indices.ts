import type { Migration } from './migration-runner';

/**
 * Migration 005: Add uniqueness constraints and safe indices
 * Phase 0 of DB modernization - safety net & correctness hardening
 */
export const migration005SafeIndices: Migration = {
  down: `
    -- Remove all indices created in this migration
    DROP INDEX IF EXISTS idx_file_chunks_unique_position;
    DROP INDEX IF EXISTS idx_file_chunks_content_hash;
    DROP INDEX IF EXISTS idx_file_chunks_file_record_id;
    DROP INDEX IF EXISTS idx_file_chunks_type;
    DROP INDEX IF EXISTS idx_file_chunks_file_type;
  `,
  ledgerKey: 'custom-005-safe-indices',
  name: 'safe_indices',
  up: `
    -- Add uniqueness constraint on file_record_id and chunk_index
    -- This prevents duplicate chunks for the same position in a file
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_chunks_unique_position 
    ON file_chunks(file_record_id, chunk_index);

    -- Add index on content_hash for efficient deduplication checks
    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_hash 
    ON file_chunks(content_hash);

    -- Add index on file_record_id for faster chunk lookups by file
    CREATE INDEX IF NOT EXISTS idx_file_chunks_file_record_id 
    ON file_chunks(file_record_id);

    -- Add index on chunk_type for filtering by type
    CREATE INDEX IF NOT EXISTS idx_file_chunks_type 
    ON file_chunks(chunk_type);

    -- Add composite index for common query patterns
    CREATE INDEX IF NOT EXISTS idx_file_chunks_file_type 
    ON file_chunks(file_record_id, chunk_type);
  `,
  version: 5,
};
