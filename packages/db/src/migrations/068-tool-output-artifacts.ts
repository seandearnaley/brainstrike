import type { Migration } from './migration-runner';

/**
 * Durable, thread-scoped storage for complete oversized tool outputs.
 *
 * Content is BYTEA rather than text/jsonb so U+0000 and every other UTF-8 byte
 * survive exactly. The provider never receives a database id directly from
 * this table: callers expose the id only through the opaque
 * ToolOutputArtifactReference contract and resolve it under resource+thread
 * scope.
 *
 * There are deliberately no foreign keys to Mastra tables. The numbered
 * migration runner executes against a bare schema, and artifacts have a
 * bounded independent retention lifecycle. Factory reset owns explicit
 * deletion on both web and desktop paths.
 */
export const migration068ToolOutputArtifacts: Migration = {
  down: `
    DROP INDEX IF EXISTS bst_tool_output_artifacts_expires_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_tool_output_artifacts_scope_call_uidx;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_assistant_tool_output_artifacts;
  `,
  name: 'tool_output_artifacts',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_tool_output_artifacts (
      id           TEXT PRIMARY KEY DEFAULT (uuidv7()::text),
      resource_id  TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      run_id       TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      format       TEXT NOT NULL,
      content      BYTEA NOT NULL,
      byte_length  BIGINT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      CONSTRAINT bst_tool_output_artifacts_resource_check
        CHECK (octet_length(resource_id) BETWEEN 1 AND 512),
      CONSTRAINT bst_tool_output_artifacts_thread_check
        CHECK (octet_length(thread_id) BETWEEN 1 AND 512),
      CONSTRAINT bst_tool_output_artifacts_run_check
        CHECK (octet_length(run_id) BETWEEN 1 AND 512),
      CONSTRAINT bst_tool_output_artifacts_call_check
        CHECK (octet_length(tool_call_id) BETWEEN 1 AND 512),
      CONSTRAINT bst_tool_output_artifacts_format_check
        CHECK (format IN ('json', 'text')),
      CONSTRAINT bst_tool_output_artifacts_bytes_check
        CHECK (byte_length >= 0 AND byte_length = octet_length(content)),
      CONSTRAINT bst_tool_output_artifacts_expiry_check
        CHECK (expires_at > created_at)
    );
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS bst_tool_output_artifacts_scope_call_uidx
      ON brainstrike_assistant_tool_output_artifacts (
        resource_id, thread_id, run_id, tool_call_id
      );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS bst_tool_output_artifacts_expires_idx
      ON brainstrike_assistant_tool_output_artifacts (expires_at, id);
  `,
  version: 68,
};
