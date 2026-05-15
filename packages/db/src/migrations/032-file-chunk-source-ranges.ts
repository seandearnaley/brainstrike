import type { Migration } from './migration-runner';

export const migration032FileChunkSourceRanges: Migration = {
  version: 32,
  name: 'file_chunk_source_ranges',
  up: `
    ALTER TABLE file_chunks
      ADD COLUMN IF NOT EXISTS start_line INTEGER,
      ADD COLUMN IF NOT EXISTS end_line INTEGER,
      ADD COLUMN IF NOT EXISTS start_offset INTEGER,
      ADD COLUMN IF NOT EXISTS end_offset INTEGER;

    -- Existing chunks predate persisted line ranges. Brainstrike's DB contract is
    -- greenfield/reset-required for unreleased schema changes, so this migration
    -- intentionally invalidates old chunk rows and lets the existing collection
    -- indexing status UI surface the re-indexing work. Keeping legacy chunks
    -- would make line-aware retrieval nondeterministic because some semantic hits
    -- could not map back to source lines.
    UPDATE file_records
    SET chunks_processed_at = NULL,
        chunks_count = 0
    WHERE id IN (
      SELECT DISTINCT file_record_id
      FROM file_chunks
      WHERE start_line IS NULL
         OR end_line IS NULL
         OR start_offset IS NULL
         OR end_offset IS NULL
    );

    DELETE FROM file_chunks
    WHERE start_line IS NULL
       OR end_line IS NULL
       OR start_offset IS NULL
       OR end_offset IS NULL;
  `,
  down: `
    ALTER TABLE file_chunks
      DROP COLUMN IF EXISTS end_offset,
      DROP COLUMN IF EXISTS start_offset,
      DROP COLUMN IF EXISTS end_line,
      DROP COLUMN IF EXISTS start_line;
  `,
};
