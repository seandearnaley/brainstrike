import type { Migration } from './migration-runner';

export const migration036WorkspaceIndexSystemRole: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_embedding_sets_workspace_index_system_role;
    --> statement-breakpoint
    ALTER TABLE embedding_sets
      DROP COLUMN IF EXISTS system_role;
  `,
  ledgerKey: 'custom-036-workspace-index-system-role',
  name: 'workspace_index_system_role',
  up: `
    ALTER TABLE embedding_sets
      ADD COLUMN IF NOT EXISTS system_role TEXT;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_sets_workspace_index_system_role
      ON embedding_sets(system_role)
      WHERE system_role = 'workspace-index';
  `,
  version: 36,
};
