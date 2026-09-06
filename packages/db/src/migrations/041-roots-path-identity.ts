import type { Migration } from './migration-runner';

/**
 * Root identity must be durable root id, not display/path. Web File System
 * Access handles expose only the directory name as `path`, so two different
 * user-selected roots can both be named "project". Keep path uniqueness for
 * desktop path roots, where the path is a real absolute filesystem identity,
 * but allow FSA roots to coexist by primary-key id.
 */
export const migration041RootsPathIdentity: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_roots_path_identity;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_roots_path
      ON roots(path)
      WHERE path IS NOT NULL;
  `,
  ledgerKey: 'custom-041-roots-path-identity',
  name: 'roots_path_identity',
  up: `
    DROP INDEX IF EXISTS idx_roots_path;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_roots_path_identity
      ON roots(path)
      WHERE path IS NOT NULL
        AND kind = 'path';
  `,
  version: 41,
};
