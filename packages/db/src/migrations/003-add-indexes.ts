import type { Migration } from './migration-runner';

export const migration003AddIndexes: Migration = {
  down: `
		-- Drop relationship indexes and table
		DROP INDEX IF EXISTS idx_file_relationships_type;
		DROP INDEX IF EXISTS idx_file_relationships_target;
		DROP INDEX IF EXISTS idx_file_relationships_source;
		DROP TABLE IF EXISTS file_relationships;

		-- Drop tags indexes and table
		DROP INDEX IF EXISTS idx_file_tags_tag;
		DROP INDEX IF EXISTS idx_file_tags_unique;
		DROP TABLE IF EXISTS file_tags;

		-- Drop file type specific indexes
		DROP INDEX IF EXISTS idx_file_records_javascript;
		DROP INDEX IF EXISTS idx_file_records_typescript;

		-- Drop composite indexes
		DROP INDEX IF EXISTS idx_file_records_size_updated;
		DROP INDEX IF EXISTS idx_file_records_path_name;
	`,
  name: 'add_performance_indexes',
  up: `
		-- Add composite indexes for common query patterns
		CREATE INDEX IF NOT EXISTS idx_file_records_path_name ON file_records(path, name);
		CREATE INDEX IF NOT EXISTS idx_file_records_size_updated ON file_records(size, updated_at DESC);
		
		-- Add partial indexes for specific file types (example)
		CREATE INDEX IF NOT EXISTS idx_file_records_typescript 
		ON file_records(path, updated_at DESC) 
		WHERE name LIKE '%.ts' OR name LIKE '%.tsx';
		
		CREATE INDEX IF NOT EXISTS idx_file_records_javascript 
		ON file_records(path, updated_at DESC) 
		WHERE name LIKE '%.js' OR name LIKE '%.jsx';

		-- Create tags table for future file categorization
		CREATE TABLE IF NOT EXISTS file_tags (
			id TEXT PRIMARY KEY,
			file_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
			tag TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		-- Create unique constraint to prevent duplicate tags
		CREATE UNIQUE INDEX IF NOT EXISTS idx_file_tags_unique ON file_tags(file_id, tag);
		CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag);

		-- Create file relationships table
		CREATE TABLE IF NOT EXISTS file_relationships (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
			target_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
			relationship_type TEXT NOT NULL, -- 'imports', 'exports', 'references', etc.
			metadata JSONB,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		-- Indexes for relationships
		CREATE INDEX IF NOT EXISTS idx_file_relationships_source ON file_relationships(source_id);
		CREATE INDEX IF NOT EXISTS idx_file_relationships_target ON file_relationships(target_id);
		CREATE INDEX IF NOT EXISTS idx_file_relationships_type ON file_relationships(relationship_type);
	`,
  version: 3,
};
