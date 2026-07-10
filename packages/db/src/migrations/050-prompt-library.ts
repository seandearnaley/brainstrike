import type { Migration } from './migration-runner';

/**
 * Migration 050: durable Prompt Workbench records and semantic recall space.
 *
 * Prompt items are application records, not pretend files, so they own their
 * metadata, revision history, and vector directly. The dedicated embedding set
 * keeps prompt recall out of workspace/file search while reusing the same
 * renderer-only local embedding model and pgvector extension.
 */
export const migration050PromptLibrary: Migration = {
  down: `
    DROP TABLE IF EXISTS prompt_item_revisions;
    --> statement-breakpoint
    DROP TABLE IF EXISTS prompt_items;
    --> statement-breakpoint
    DELETE FROM embedding_sets WHERE system_role = 'prompt-library';
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_embedding_sets_prompt_library_system_role;
  `,
  name: 'prompt_library',
  up: `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_sets_prompt_library_system_role
      ON embedding_sets(system_role)
      WHERE system_role = 'prompt-library';
    --> statement-breakpoint

    INSERT INTO embedding_sets (
      id,
      model_id,
      model_key,
      dimensions,
      distance,
      name,
      description,
      system_role,
      created_at
    ) VALUES (
      'system:prompt-library',
      'Xenova/all-MiniLM-L6-v2',
      'local::Xenova/all-MiniLM-L6-v2',
      384,
      'cosine',
      'Prompt Library',
      'System-managed semantic recall for prompts, snippets, and fragments.',
      'prompt-library',
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    ON CONFLICT (id) DO UPDATE SET
      model_id = EXCLUDED.model_id,
      model_key = EXCLUDED.model_key,
      dimensions = EXCLUDED.dimensions,
      distance = EXCLUDED.distance,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      system_role = EXCLUDED.system_role;
    --> statement-breakpoint

    CREATE TABLE IF NOT EXISTS prompt_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMPTZ,
      source_url TEXT,
      rating INTEGER,
      model_key TEXT,
      model_settings JSONB,
      revision INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      last_used_action TEXT,
      embedding VECTOR,
      embedding_set_id TEXT,
      embedding_revision INTEGER,
      embedding_error TEXT,
      embedding_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT prompt_items_kind_check CHECK (kind IN ('prompt', 'snippet', 'fragment')),
      CONSTRAINT prompt_items_title_check CHECK (length(trim(title)) > 0),
      CONSTRAINT prompt_items_content_check CHECK (length(trim(content)) > 0),
      CONSTRAINT prompt_items_tags_check CHECK (jsonb_typeof(tags) = 'array'),
      CONSTRAINT prompt_items_rating_check CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
      CONSTRAINT prompt_items_revision_check CHECK (revision > 0),
      CONSTRAINT prompt_items_use_count_check CHECK (use_count >= 0),
      CONSTRAINT prompt_items_last_used_action_check CHECK (
        last_used_action IS NULL OR last_used_action IN ('compose', 'insert', 'new-thread')
      )
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_prompt_items_kind_updated_at
      ON prompt_items(kind, updated_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_prompt_items_favorite_updated_at
      ON prompt_items(updated_at DESC)
      WHERE is_favorite = TRUE;
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_prompt_items_embedding_set_id
      ON prompt_items(embedding_set_id);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_prompt_items_tags
      ON prompt_items USING gin(tags);
    --> statement-breakpoint

    CREATE TABLE IF NOT EXISTS prompt_item_revisions (
      id TEXT PRIMARY KEY,
      prompt_item_id TEXT NOT NULL REFERENCES prompt_items(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      model_key TEXT,
      model_settings JSONB,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT prompt_item_revisions_revision_check CHECK (revision > 0),
      CONSTRAINT prompt_item_revisions_unique UNIQUE (prompt_item_id, revision)
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_prompt_item_revisions_item_revision
      ON prompt_item_revisions(prompt_item_id, revision DESC);
  `,
  version: 50,
};
