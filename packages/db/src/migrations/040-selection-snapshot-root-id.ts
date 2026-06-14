import type { Migration } from './migration-runner';

/**
 * Multi-root selection snapshots: exact root identity for duplicate relative paths.
 *
 * Existing snapshots are retained with NULL root_id and continue to behave as
 * legacy path-only snapshots. New root-aware writers populate root_id so
 * retrieval can distinguish /src/foo.ts in two active roots.
 */
export const migration040SelectionSnapshotRootId: Migration = {
  version: 40,
  name: 'selection_snapshot_root_id',
  up: `
    ALTER TABLE IF EXISTS selection_snapshot_files
      ADD COLUMN IF NOT EXISTS root_id TEXT REFERENCES roots(id) ON DELETE CASCADE;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_selection_snapshot_files_root_id
      ON selection_snapshot_files (root_id);
    --> statement-breakpoint

    DROP INDEX IF EXISTS idx_selection_snapshot_files_unique;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_snapshot_files_unique
      ON selection_snapshot_files (snapshot_id, file_path, root_id)
      WHERE root_id IS NOT NULL;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_snapshot_files_unique_legacy
      ON selection_snapshot_files (snapshot_id, file_path)
      WHERE root_id IS NULL;
  `,
  down: `
    DROP INDEX IF EXISTS idx_selection_snapshot_files_unique_legacy;
    DROP INDEX IF EXISTS idx_selection_snapshot_files_unique;
    DROP INDEX IF EXISTS idx_selection_snapshot_files_root_id;

    ALTER TABLE IF EXISTS selection_snapshot_files
      DROP COLUMN IF EXISTS root_id;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_snapshot_files_unique
      ON selection_snapshot_files (snapshot_id, file_path);
  `,
};
