import type { Migration } from './migration-runner';

/**
 * Migration 082: persisted, versioned Canvas documents (BST-1173).
 *
 * A document is the ordered set of rows sharing `canvas_id`; its current
 * content is the row with the greatest `version`. Both the row id and canvas id
 * are caller-supplied app-side uuidv7 values. Creator is CHECK-constrained so
 * widening the vocabulary is an explicit migration.
 *
 * NO foreign keys: numbered migrations run against a bare schema without
 * Mastra thread/resource parents. Thread deletion and factory reset explicitly
 * own this sidecar's lifecycle.
 */
export const migration082CanvasDocuments: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_canvas_versions;',
  ledgerKey: 'custom-082-canvas-documents',
  name: 'canvas_documents',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_canvas_versions (
      id text PRIMARY KEY,
      canvas_id text NOT NULL,
      thread_id text NOT NULL,
      resource_id text NOT NULL,
      title text NOT NULL,
      html text NOT NULL,
      version integer NOT NULL CHECK (version >= 1),
      created_by text NOT NULL CHECK (created_by IN ('assistant', 'user')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (canvas_id, version)
    );

    CREATE INDEX IF NOT EXISTS brainstrike_canvas_versions_thread_idx
      ON brainstrike_canvas_versions (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_canvas_versions_canvas_version_idx
      ON brainstrike_canvas_versions (canvas_id, version DESC);
  `,
  version: 82,
};
