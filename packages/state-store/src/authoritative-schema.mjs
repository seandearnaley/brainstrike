// @ts-check
// SQLite port of the authoritative tables that a StateStore domain owns, from the PostgreSQL migrations.
// JSONB -> validated JSON TEXT; booleans -> checked INTEGER; UTC timestamps -> TEXT; UUIDs -> caller-minted TEXT.
// BIGSERIAL -> AUTOINCREMENT. The MCP authority FK is complete and enabled on the writer.
export const AUTHORITATIVE_SCHEMA = `
CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL,
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
) STRICT;
INSERT INTO threads SELECT thread_id, max(seq), min(created_at), max(created_at) FROM run_events GROUP BY thread_id;

-- PostgreSQL migrations 79
CREATE TABLE IF NOT EXISTS brainstrike_mind_ops (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'prompt_item')),
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op = 'delete'),
      resource_id TEXT,
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_mind_ops_entity_idx
      ON brainstrike_mind_ops (entity_kind, entity_id);

-- PostgreSQL migrations 109
CREATE TABLE IF NOT EXISTS brainstrike_worktrees (
      id TEXT PRIMARY KEY NOT NULL,
      repo_common_dir TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      branch TEXT,
      base_ref TEXT NOT NULL,
      created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'user')),
      thread_id TEXT,
      run_id TEXT,
      setup_status TEXT NOT NULL DEFAULT 'none'
        CHECK (setup_status IN ('failed', 'none', 'skipped', 'succeeded')),
      setup_output TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      archived_at TEXT,
      archive_snapshot_ref TEXT,
      setup_reason TEXT,
      CONSTRAINT brainstrike_worktrees_archive_consistency
        CHECK ((archived_at IS NULL) = (archive_snapshot_ref IS NULL))
    ) STRICT;


    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_repo_active_idx
      ON brainstrike_worktrees (repo_common_dir)
      WHERE archived_at IS NULL;

    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_thread_idx
      ON brainstrike_worktrees (thread_id);

-- PostgreSQL migrations 110
CREATE TABLE IF NOT EXISTS brainstrike_forge_prs (
      repo_common_dir TEXT NOT NULL,
      branch TEXT NOT NULL,
      number INTEGER,
      url TEXT,
      title TEXT,
      state TEXT CHECK (state IS NULL OR state IN ('open', 'closed', 'merged')),
      is_draft INTEGER CHECK (is_draft IN (0,1)),
      review_decision TEXT,
      checks_json TEXT CHECK (checks_json IS NULL OR json_valid(checks_json)),
      head_sha TEXT,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (repo_common_dir, branch),
      CHECK (
        (
          number IS NULL AND url IS NULL AND title IS NULL AND state IS NULL
          AND is_draft IS NULL AND checks_json IS NULL AND head_sha IS NULL
        ) OR (
          number IS NOT NULL AND url IS NOT NULL AND title IS NOT NULL AND state IS NOT NULL
          AND is_draft IS NOT NULL AND checks_json IS NOT NULL AND head_sha IS NOT NULL
        )
      )
    ) STRICT;

-- PostgreSQL migrations 115 final authority
CREATE TABLE brainstrike_mcp_task_authorities (
      authority_epoch TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL CHECK (length(CAST(server_id AS BLOB)) BETWEEN 1 AND 512),
      resource TEXT NOT NULL CHECK (length(CAST(resource AS BLOB)) BETWEEN 1 AND 2048),
      principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
      runtime_id TEXT NOT NULL CHECK (length(CAST(runtime_id AS BLOB)) BETWEEN 1 AND 512),
      connection_generation INTEGER NOT NULL CHECK (connection_generation >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (authority_epoch, server_id, resource, principal_id),
      CHECK (created_at <= updated_at),
      CHECK (retired_at IS NULL OR retired_at = updated_at)
    ) STRICT;
    CREATE UNIQUE INDEX brainstrike_mcp_task_authorities_live_scope_idx
      ON brainstrike_mcp_task_authorities (server_id, resource, principal_id)
      WHERE retired_at IS NULL;

-- PostgreSQL migrations 114
CREATE TABLE IF NOT EXISTS brainstrike_mcp_tasks (
      server_id TEXT NOT NULL CHECK (length(CAST(server_id AS BLOB)) BETWEEN 1 AND 512),
      resource TEXT NOT NULL CHECK (length(CAST(resource AS BLOB)) BETWEEN 1 AND 2048),
      principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
      task_id TEXT NOT NULL CHECK (length(CAST(task_id AS BLOB)) BETWEEN 1 AND 1024),
      status TEXT NOT NULL CHECK (
        status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')
      ),
      status_message TEXT,
      input_metadata TEXT CHECK (input_metadata IS NULL OR json_valid(input_metadata)),
      result_metadata TEXT CHECK (result_metadata IS NULL OR json_valid(result_metadata)),
      history TEXT CHECK (history IS NULL OR json_valid(history)) NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      authority_epoch TEXT NOT NULL,
      blocked_diagnostic TEXT CHECK (blocked_diagnostic IS NULL OR (json_valid(blocked_diagnostic) AND json_type(blocked_diagnostic) = 'object')),
      PRIMARY KEY (authority_epoch, task_id),
      FOREIGN KEY (authority_epoch, server_id, resource, principal_id) REFERENCES brainstrike_mcp_task_authorities(authority_epoch, server_id, resource, principal_id) ON DELETE CASCADE,
      CHECK (length(CAST(COALESCE(blocked_diagnostic, '') AS BLOB)) <= 4096),
      CHECK (input_metadata IS NULL OR json_type(input_metadata) = 'object'),
      CHECK (result_metadata IS NULL OR json_type(result_metadata) = 'object'),
      CHECK (status_message IS NULL OR length(CAST(status_message AS BLOB)) <= 4096),
      CHECK (json_type(history) = 'array' AND json_array_length(history) BETWEEN 1 AND 32),
      CHECK (length(CAST(COALESCE(input_metadata, '') AS BLOB)) <= 65536),
      CHECK (length(CAST(COALESCE(result_metadata, '') AS BLOB)) <= 65536),
      CHECK (status <> 'input_required' OR input_metadata IS NOT NULL),
      CHECK (status NOT IN ('completed', 'failed') OR result_metadata IS NOT NULL),
      CHECK ((status IN ('completed', 'failed', 'cancelled') OR blocked_diagnostic IS NOT NULL) = (terminal_at IS NOT NULL)),
      CHECK (created_at <= updated_at AND (terminal_at IS NULL OR terminal_at = updated_at))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS brainstrike_mcp_tasks_resume_idx
      ON brainstrike_mcp_tasks (authority_epoch, updated_at)
      WHERE terminal_at IS NULL;
`;
