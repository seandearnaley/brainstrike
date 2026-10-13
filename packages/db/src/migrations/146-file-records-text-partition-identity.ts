import type { Migration } from './migration-runner.js';

/**
 * Migration 146: the native TEXT partition's managed-cache identity (BST-1988).
 *
 * Text search needs no embedding model, so a workspace indexed in TEXT mode with
 * no collection keeps its sources as rooted `file_records` with a NULL
 * `embedding_set_id`. Migration 039's identity index covers only rows with a
 * collection; this is the same (root, path) uniqueness for the TEXT partition.
 * A NULL set means that partition alone, never "any collection", so the two
 * partitions can hold the same root and path without colliding.
 */
export const migration146FileRecordsTextPartitionIdentity: Migration = {
  down: 'DROP INDEX IF EXISTS idx_file_records_text_partition_identity;',
  ledgerKey: 'custom-146-file-records-text-partition-identity',
  name: 'file_records_text_partition_identity',
  up: `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_text_partition_identity
      ON file_records(root_id, path)
      WHERE embedding_set_id IS NULL
        AND root_id IS NOT NULL;
  `,
  version: 146,
};
