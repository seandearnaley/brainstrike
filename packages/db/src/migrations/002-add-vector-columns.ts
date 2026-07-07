import type { Migration } from './migration-runner';

export const migration002AddVectorColumns: Migration = {
  down: `
		-- Drop indexes
		-- DROP INDEX IF EXISTS idx_file_records_embedding;
		DROP INDEX IF EXISTS idx_file_records_processed_at;
		DROP INDEX IF EXISTS idx_file_records_content_hash;

		-- Remove columns
		ALTER TABLE file_records
		DROP COLUMN IF EXISTS processed_at,
		DROP COLUMN IF EXISTS token_count,
		DROP COLUMN IF EXISTS content_hash,
		DROP COLUMN IF EXISTS content,
		DROP COLUMN IF EXISTS embedding;
	`,
  name: 'add_vector_columns',
  up: async (db) => {
    try {
      await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/extension "vector" is not available/i.test(message)) {
        throw error;
      }
      try {
        await db.exec('ROLLBACK');
      } catch {}
    }

    await db.exec(`
			-- Add embedding columns to file_records
			ALTER TABLE file_records 
			ADD COLUMN IF NOT EXISTS embedding REAL[],
			ADD COLUMN IF NOT EXISTS content TEXT,
			ADD COLUMN IF NOT EXISTS content_hash TEXT,
			ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0,
			ADD COLUMN IF NOT EXISTS processed_at TEXT;

			-- Create index for content hash lookups
			CREATE INDEX IF NOT EXISTS idx_file_records_content_hash ON file_records(content_hash);
			
			-- Create index for processed files
			CREATE INDEX IF NOT EXISTS idx_file_records_processed_at ON file_records(processed_at) 
			WHERE processed_at IS NOT NULL;
		`);
    // Note: file_records embedding index is intentionally omitted in tests/non-vector env
  },
  version: 2,
};
