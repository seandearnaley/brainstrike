import type { Migration } from './migration-runner';

/** Principal-bound durable handles for the 2026 Tasks extension (BST-1562). */
export const migration114McpTasks: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_mcp_tasks;',
  ledgerKey: 'custom-114-mcp-tasks',
  name: 'mcp_tasks',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_mcp_tasks (
      server_id text NOT NULL CHECK (octet_length(server_id) BETWEEN 1 AND 512),
      resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
      principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 512),
      generation bigint NOT NULL CHECK (generation >= 0),
      task_id text NOT NULL CHECK (octet_length(task_id) BETWEEN 1 AND 1024),
      status text NOT NULL CHECK (
        status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')
      ),
      status_message text,
      input_metadata jsonb,
      result_metadata jsonb,
      history jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      terminal_at timestamptz,
      PRIMARY KEY (server_id, resource, principal_id, generation, task_id),
      CHECK (input_metadata IS NULL OR jsonb_typeof(input_metadata) = 'object'),
      CHECK (result_metadata IS NULL OR jsonb_typeof(result_metadata) = 'object'),
      CHECK (status_message IS NULL OR octet_length(status_message) <= 4096),
      CHECK (jsonb_typeof(history) = 'array' AND jsonb_array_length(history) BETWEEN 1 AND 32),
      CHECK (octet_length(COALESCE(input_metadata::text, '')) <= 65536),
      CHECK (octet_length(COALESCE(result_metadata::text, '')) <= 65536),
      CHECK (status <> 'input_required' OR input_metadata IS NOT NULL),
      CHECK (status NOT IN ('completed', 'failed') OR result_metadata IS NOT NULL),
      CHECK ((status IN ('completed', 'failed', 'cancelled')) = (terminal_at IS NOT NULL)),
      CHECK (created_at <= updated_at AND (terminal_at IS NULL OR terminal_at = updated_at))
    );
    CREATE INDEX IF NOT EXISTS brainstrike_mcp_tasks_resume_idx
      ON brainstrike_mcp_tasks (server_id, resource, principal_id, generation, updated_at)
      WHERE terminal_at IS NULL;
  `,
  version: 114,
};
