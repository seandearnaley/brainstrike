import type { Migration } from './migration-runner';

/**
 * Index consolidation from the PG18 skip-scan audit
 * (docs/pg18-skip-scan-audit.md). Drops four provably redundant B-tree
 * indexes; the first three drops are backed by before/after EXPLAIN evidence
 * in the audit (~2.6 MiB persisted at the seeded volume, scaling linearly):
 *
 * 1. idx_embedding_cache_content_hash — leading-column prefix of the UNIQUE
 *    idx_embedding_cache_content_model (content_hash, model_key). No
 *    hash-only query shape exists (get/getBatch/upsert/evict all bind
 *    model_key or accessed_at). ~2 MB per 40k cached embeddings.
 * 2. idx_file_token_cache_lookup — exact duplicate (same columns, same order)
 *    of the UNIQUE idx_file_token_cache_folder_path_unique.
 * 3. idx_file_token_cache_folder — prefix of both (folder_id, file_path)
 *    UNIQUE and (folder_id, counting_mode); the planner already preferred the
 *    composites at baseline.
 * 4. idx_prompt_item_revisions_item_revision — same (prompt_item_id, revision)
 *    key as the UNIQUE prompt_item_revisions_unique constraint (migration 051)
 *    / idx_prompt_item_revisions_unique (drizzle schema); B-tree scans run
 *    backwards, so the DESC ordering adds nothing the UNIQUE cannot serve.
 *    No code references the index by name.
 *
 * NOT dropped (audit verdict KEEP — do not add here without new evidence):
 * idx_file_records_root_id / _embedding_set_id / _path (the partial
 * idx_file_records_root_identity cannot serve their real query shapes),
 * everything on job_queue and file_chunks.
 *
 * The numbered (test-only) path names the token-cache indexes differently
 * (migration 016: idx_token_cache_lookup / idx_token_cache_folder, with the
 * unique enforced as the constraint index
 * file_token_cache_folder_id_file_path_key). The IF EXISTS list covers both
 * spellings so the migration is no-op-safe on either path.
 *
 * NEVER drop idx_embedding_cache_content_model or
 * idx_file_token_cache_folder_path_unique / the folder+path UNIQUE
 * constraint / prompt_item_revisions_unique — they are the
 * correctness-bearing survivors.
 */
export const migration063IndexConsolidation: Migration = {
  down: `
    -- Table-existence guards: embedding_cache exists only on the drizzle
    -- (real-app) path, so the numbered (test) path must be able to roll back
    -- without it (see migration-integration.test.ts full-down scenario).
    DO $$
    BEGIN
      IF to_regclass('embedding_cache') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_embedding_cache_content_hash
          ON embedding_cache(content_hash);
      END IF;
      IF to_regclass('file_token_cache') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_file_token_cache_lookup
          ON file_token_cache(folder_id, file_path);
        CREATE INDEX IF NOT EXISTS idx_file_token_cache_folder
          ON file_token_cache(folder_id);
      END IF;
      IF to_regclass('prompt_item_revisions') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_prompt_item_revisions_item_revision
          ON prompt_item_revisions(prompt_item_id, revision DESC);
      END IF;
    END
    $$;
  `,
  name: 'index_consolidation',
  up: `
    -- Prefix of UNIQUE idx_embedding_cache_content_model (content_hash, model_key)
    DROP INDEX IF EXISTS idx_embedding_cache_content_hash;
    --> statement-breakpoint

    -- Exact duplicate of UNIQUE idx_file_token_cache_folder_path_unique
    DROP INDEX IF EXISTS idx_file_token_cache_lookup;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_token_cache_lookup; -- numbered-path spelling (tests)
    --> statement-breakpoint

    -- Prefix of (folder_id, file_path) UNIQUE and (folder_id, counting_mode)
    DROP INDEX IF EXISTS idx_file_token_cache_folder;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_token_cache_folder; -- numbered-path spelling (tests)
    --> statement-breakpoint

    -- Same key as the UNIQUE prompt_item_revisions_unique constraint (051)
    DROP INDEX IF EXISTS idx_prompt_item_revisions_item_revision;
  `,
  version: 63,
};
