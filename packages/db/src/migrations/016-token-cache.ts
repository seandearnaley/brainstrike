import type { Migration } from './migration-runner';

/**
 * Migration 016: Token Cache
 *
 * Creates the file_token_cache table for persistent token counting.
 * This enables fast, deterministic token counts that survive across sessions.
 *
 * Features:
 * - Content-based invalidation via xxHash64
 * - Supports both accurate (tiktoken) and heuristic counting modes
 * - Efficient batch queries with indexes
 */
export const migration016TokenCache: Migration = {
  down: `
    DROP TABLE IF EXISTS file_token_cache;
  `,
  name: 'token_cache',
  up: `
    -- Create token cache table
    CREATE TABLE IF NOT EXISTS file_token_cache (
      id SERIAL PRIMARY KEY,
      -- Folder identifier (e.g., root folder name)
      folder_id TEXT NOT NULL,
      -- Relative file path within the folder
      file_path TEXT NOT NULL,
      -- xxHash64 of file content (16-char hex string)
      content_hash TEXT NOT NULL,
      -- File size in bytes
      file_size BIGINT NOT NULL,
      -- File modification time in milliseconds (optional)
      mtime_ms BIGINT,
      -- Cached token count
      token_count INTEGER NOT NULL,
      -- Counting mode: 'accurate' (tiktoken) or 'heuristic' (char/4)
      counting_mode TEXT NOT NULL CHECK (counting_mode IN ('accurate', 'heuristic')),
      -- Model encoding used for accurate mode (e.g., 'o200k_base')
      model_encoding TEXT,
      -- Timestamps
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- Unique constraint for folder + path combination
      UNIQUE(folder_id, file_path)
    );

    -- Index for folder + path lookups (primary use case)
    CREATE INDEX IF NOT EXISTS idx_token_cache_lookup
      ON file_token_cache(folder_id, file_path);

    -- Index for content hash lookups (deduplication)
    CREATE INDEX IF NOT EXISTS idx_token_cache_hash
      ON file_token_cache(content_hash);

    -- Index for folder-level operations (clear folder, stats)
    CREATE INDEX IF NOT EXISTS idx_token_cache_folder
      ON file_token_cache(folder_id);

    -- Index for counting mode queries (mode migration)
    CREATE INDEX IF NOT EXISTS idx_token_cache_mode
      ON file_token_cache(folder_id, counting_mode);
  `,
  version: 16,
};
