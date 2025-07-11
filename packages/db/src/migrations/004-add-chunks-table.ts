import type { Migration } from './migration-runner';

export const migration004AddChunksTable: Migration = {
  version: 4,
  name: 'add_chunks_table',
  up: `
		-- Enable pgvector extension for vector operations
		CREATE EXTENSION IF NOT EXISTS vector;

		-- Create file_chunks table for storing chunked content with vectors
		CREATE TABLE IF NOT EXISTS file_chunks (
			id TEXT PRIMARY KEY,
			file_record_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			token_count INTEGER DEFAULT 0,
			chunk_type TEXT DEFAULT 'text',
			chunk_size INTEGER DEFAULT 0,
			embedding VECTOR(768), -- BGE-M3 uses 768 dimensions
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (file_record_id) REFERENCES file_records(id) ON DELETE CASCADE
		);

		-- Create indexes for efficient querying
		CREATE INDEX IF NOT EXISTS idx_file_chunks_file_record_id ON file_chunks(file_record_id);
		CREATE INDEX IF NOT EXISTS idx_file_chunks_chunk_index ON file_chunks(chunk_index);
		CREATE INDEX IF NOT EXISTS idx_file_chunks_content_hash ON file_chunks(content_hash);
		CREATE INDEX IF NOT EXISTS idx_file_chunks_token_count ON file_chunks(token_count);
		CREATE INDEX IF NOT EXISTS idx_file_chunks_chunk_type ON file_chunks(chunk_type);
		
		-- Create vector index for similarity search using HNSW (more efficient than IVFFlat for most cases)
		CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding ON file_chunks 
		USING hnsw (embedding vector_cosine_ops);

		-- Add chunk processing metadata to file_records
		ALTER TABLE file_records 
		ADD COLUMN IF NOT EXISTS chunks_processed_at TEXT,
		ADD COLUMN IF NOT EXISTS chunks_count INTEGER DEFAULT 0,
		ADD COLUMN IF NOT EXISTS chunking_strategy TEXT DEFAULT 'sentence';

		-- Create index for chunk processing status
		CREATE INDEX IF NOT EXISTS idx_file_records_chunks_processed ON file_records(chunks_processed_at) 
		WHERE chunks_processed_at IS NOT NULL;
	`,
  down: `
		-- Drop indexes
		DROP INDEX IF EXISTS idx_file_records_chunks_processed;
		DROP INDEX IF EXISTS idx_file_chunks_embedding;
		DROP INDEX IF EXISTS idx_file_chunks_chunk_type;
		DROP INDEX IF EXISTS idx_file_chunks_token_count;
		DROP INDEX IF EXISTS idx_file_chunks_content_hash;
		DROP INDEX IF EXISTS idx_file_chunks_chunk_index;
		DROP INDEX IF EXISTS idx_file_chunks_file_record_id;
		
		-- Remove columns from file_records
		ALTER TABLE file_records 
		DROP COLUMN IF EXISTS chunking_strategy,
		DROP COLUMN IF EXISTS chunks_count,
		DROP COLUMN IF EXISTS chunks_processed_at;
		
		-- Drop chunks table
		DROP TABLE IF EXISTS file_chunks;
	`,
};
