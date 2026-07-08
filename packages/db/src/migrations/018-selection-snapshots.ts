import type { Migration } from './migration-runner';

// Migration 018: Add selection snapshot tables for retrieval scoping

export const migration018SelectionSnapshots: Migration = {
  down: `
    DROP TABLE IF EXISTS selection_snapshot_files;
    DROP TABLE IF EXISTS selection_snapshots;
  `,
  name: 'selection_snapshots',
  up: `
    CREATE TABLE IF NOT EXISTS selection_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS selection_snapshot_files (
      snapshot_id UUID NOT NULL REFERENCES selection_snapshots(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_selection_snapshots_created_at
      ON selection_snapshots (created_at);

    CREATE INDEX IF NOT EXISTS idx_selection_snapshot_files_snapshot_id
      ON selection_snapshot_files (snapshot_id);

    CREATE INDEX IF NOT EXISTS idx_selection_snapshot_files_file_path
      ON selection_snapshot_files (file_path);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_snapshot_files_unique
      ON selection_snapshot_files (snapshot_id, file_path);
  `,
  version: 18,
};
