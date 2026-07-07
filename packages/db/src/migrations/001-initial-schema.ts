import type { Migration } from './migration-runner';

export const migration001InitialSchema: Migration = {
  down: `
		-- Drop indexes
		DROP INDEX IF EXISTS idx_file_records_updated_at;
		DROP INDEX IF EXISTS idx_file_records_name;
		DROP INDEX IF EXISTS idx_file_records_path;

		-- Drop table
		DROP TABLE IF EXISTS file_records;
	`,
  name: 'initial_schema',
  up: `
		-- Create file_records table
		CREATE TABLE IF NOT EXISTS file_records (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			path TEXT NOT NULL,
			size INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- Create indexes for common queries
		CREATE INDEX IF NOT EXISTS idx_file_records_path ON file_records(path);
		CREATE INDEX IF NOT EXISTS idx_file_records_name ON file_records(name);
		CREATE INDEX IF NOT EXISTS idx_file_records_updated_at ON file_records(updated_at);
	`,
  version: 1,
};
