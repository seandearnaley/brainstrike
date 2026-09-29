import type { Migration } from './migration-runner.js';

/** Preserve root ownership while distinguishing tool calls in native child threads. */
export const migration129ArtifactExecutionScope: Migration = {
  down: `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM brainstrike_assistant_tool_output_artifacts
        WHERE execution_thread_id <> thread_id) THEN
        RAISE EXCEPTION 'Cannot discard delegated artifact execution identity';
      END IF;
    END $$;
    DROP INDEX bst_tool_output_artifacts_scope_call_uidx;
    CREATE UNIQUE INDEX bst_tool_output_artifacts_scope_call_uidx
      ON brainstrike_assistant_tool_output_artifacts (resource_id, thread_id, run_id, tool_call_id);
    ALTER TABLE brainstrike_assistant_tool_output_artifacts DROP COLUMN execution_thread_id;
  `,
  ledgerKey: 'custom-129-artifact-execution-scope',
  name: 'artifact_execution_scope',
  up: `
    ALTER TABLE brainstrike_assistant_tool_output_artifacts ADD COLUMN execution_thread_id TEXT;
    UPDATE brainstrike_assistant_tool_output_artifacts SET execution_thread_id = thread_id;
    ALTER TABLE brainstrike_assistant_tool_output_artifacts
      ALTER COLUMN execution_thread_id SET NOT NULL,
      ADD CONSTRAINT bst_tool_output_artifacts_execution_thread_check
        CHECK (octet_length(execution_thread_id) BETWEEN 1 AND 512);
    DROP INDEX bst_tool_output_artifacts_scope_call_uidx;
    CREATE UNIQUE INDEX bst_tool_output_artifacts_scope_call_uidx
      ON brainstrike_assistant_tool_output_artifacts
        (resource_id, thread_id, run_id, execution_thread_id, tool_call_id);
  `,
  version: 129,
};
