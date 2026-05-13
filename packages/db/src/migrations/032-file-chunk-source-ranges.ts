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
  `,
  down: `
    ALTER TABLE file_chunks
      DROP COLUMN IF EXISTS end_offset,
      DROP COLUMN IF EXISTS start_offset,
      DROP COLUMN IF EXISTS end_line,
      DROP COLUMN IF EXISTS start_line;
  `,
};
