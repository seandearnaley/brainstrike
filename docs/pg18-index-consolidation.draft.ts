/**
 * DRAFT — NOT REGISTERED. Do not import.
 *
 * Proposed index consolidation from the PG18 skip-scan audit
 * (docs/pg18-skip-scan-audit.md). Drops three provably redundant B-tree
 * indexes; every drop is backed by before/after EXPLAIN evidence in the audit:
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
 *
 * NOT dropped (audit verdict KEEP — do not add here without new evidence):
 * idx_file_records_root_id / _embedding_set_id / _path (the partial
 * idx_file_records_root_identity cannot serve their real query shapes),
 * everything on job_queue and file_chunks.
 *
 * Adoption checklist (per AGENTS.md "MODEL CATALOG MIGRATIONS" conventions for
 * dual-registered DB migrations):
 * - Assign the next free migration number and register in BOTH
 *   packages/db/src/migrations/index.ts (numbered MigrationRunner — tests)
 *   AND the customMigrations ledger in packages/db/src/drizzle/migrate.ts
 *   (real app). Registering only one silently skips existing users or tests.
 * - Remove the index definitions from the drizzle schema
 *   (packages/db/src/schema/index.ts: 'idx_embedding_cache_content_hash',
 *   and the file_token_cache 'lookup'/'folder' index entries) so a fresh
 *   baseline doesn't recreate them.
 * - The numbered (test-only) path names the token-cache indexes differently
 *   (migration 016: idx_token_cache_lookup / idx_token_cache_folder, with the
 *   unique enforced as the constraint index
 *   file_token_cache_folder_id_file_path_key). The IF EXISTS list below
 *   covers both spellings so the migration is a no-op-safe on either path.
 * - NEVER drop idx_embedding_cache_content_model or
 *   idx_file_token_cache_folder_path_unique / the folder+path UNIQUE
 *   constraint — they are the correctness-bearing survivors.
 */
import type { Migration } from '../packages/db/src/migrations/migration-runner';

export const migrationDraftPg18IndexConsolidation: Migration = {
  down: `
    CREATE INDEX IF NOT EXISTS idx_embedding_cache_content_hash
      ON embedding_cache(content_hash);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_token_cache_lookup
      ON file_token_cache(folder_id, file_path);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_token_cache_folder
      ON file_token_cache(folder_id);
  `,
  name: 'pg18_index_consolidation_draft',
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
  `,
  // Placeholder — assign the real next version at adoption time.
  version: -1,
};
