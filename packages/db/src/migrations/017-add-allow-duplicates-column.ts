import type { Migration } from './migration-runner';

// Migration 017: Add allow_duplicates column to embedding_sets
// This fixes databases where migration 013 ran but didn't add the column
// (the column was missing from the original migration 013 SQL)

export const migration017AddAllowDuplicatesColumn: Migration = {
  down: `
    ALTER TABLE embedding_sets
      DROP COLUMN IF EXISTS allow_duplicates;
  `,
  ledgerKey: 'custom-017-add-allow-duplicates-column',
  name: 'add_allow_duplicates_column',
  up: `
    -- Add allow_duplicates column if it doesn't exist
    ALTER TABLE embedding_sets
      ADD COLUMN IF NOT EXISTS allow_duplicates BOOLEAN DEFAULT false;
  `,
  version: 17,
};
