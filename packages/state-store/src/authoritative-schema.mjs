// @ts-check
// SQLite port of the authoritative tables in the recovered schema inventory and live PostgreSQL migrations.
// JSONB -> validated JSON TEXT; booleans -> checked INTEGER; UTC timestamps -> TEXT; UUIDs -> caller-minted TEXT.
// Exact billed USD decimals remain TEXT, avoiding SQLite floating-point rounding. BIGSERIAL -> AUTOINCREMENT.
// Legacy run/thread/delegation foreign keys cannot reference tables absent from this unwired store; the MCP authority
// FK is complete and enabled on the writer. This is an explicit schema boundary, not a runtime fallback.
export const AUTHORITATIVE_SCHEMA = `
CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL,
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
) STRICT;
INSERT INTO threads SELECT thread_id, max(seq), min(created_at), max(created_at) FROM run_events GROUP BY thread_id;

-- PostgreSQL migrations 50
CREATE TABLE IF NOT EXISTS brainstrike_assistant_task_lists (
      thread_id   TEXT PRIMARY KEY NOT NULL,
      resource_id TEXT NOT NULL,
      tasks TEXT CHECK (tasks IS NULL OR json_valid(tasks)) NOT NULL DEFAULT '[]',
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

-- PostgreSQL migrations 52
CREATE TABLE IF NOT EXISTS brainstrike_assistant_edit_checkpoints (
      id             TEXT PRIMARY KEY NOT NULL,
      run_id         TEXT NOT NULL,
      resource_id    TEXT NOT NULL,
      thread_id      TEXT NOT NULL,
      tool_call_id   TEXT,
      tool_name      TEXT NOT NULL,
      op             TEXT NOT NULL CHECK (op IN ('write','string_replace','delete','rename')),
      root_id        TEXT NOT NULL,
      path           TEXT NOT NULL,
      from_path      TEXT,
      before_existed INTEGER CHECK (before_existed IN (0,1)) NOT NULL,
      before_hash    TEXT,
      before_content TEXT,
      before_size    INTEGER,
      after_hash     TEXT,
      after_existed INTEGER CHECK (after_existed IN (0,1)) NOT NULL,
      capture_status TEXT NOT NULL CHECK (capture_status IN
                       ('ok','created','skipped_binary','skipped_too_large','expired','rename')),
      reverted_at    TEXT,
      occurred_at    TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_thread_idx
      ON brainstrike_assistant_edit_checkpoints (thread_id, resource_id, occurred_at ASC, id ASC);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_run_idx
      ON brainstrike_assistant_edit_checkpoints (run_id, occurred_at ASC, id ASC);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_revert_idx
      ON brainstrike_assistant_edit_checkpoints (thread_id, reverted_at);

-- PostgreSQL migrations 62
CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_outcomes (
      run_id      TEXT PRIMARY KEY NOT NULL,
      thread_id   TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      verdict     TEXT NOT NULL CHECK (verdict IN ('succeeded','failed','mixed')),
      source      TEXT NOT NULL CHECK (source IN ('user','edit_revert','hook')),
      detail      TEXT,
      labeled_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_thread_idx
      ON brainstrike_assistant_run_outcomes (thread_id, resource_id);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_resource_idx
      ON brainstrike_assistant_run_outcomes (resource_id, labeled_at DESC);

-- PostgreSQL migrations 73
CREATE TABLE IF NOT EXISTS brainstrike_diagnostic_events (
      id          TEXT PRIMARY KEY NOT NULL,
      occurred_at TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK (severity IN ('warn','error','fatal')),
      source      TEXT NOT NULL,
      scope       TEXT,
      code        TEXT,
      message     TEXT NOT NULL,
      stack       TEXT,
      cause_chain TEXT CHECK (cause_chain IS NULL OR json_valid(cause_chain)),
      context TEXT CHECK (context IS NULL OR json_valid(context)),
      fingerprint TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      run_id      TEXT,
      thread_id   TEXT,
      resource_id TEXT,
      root_id     TEXT,
      app_version TEXT NOT NULL,
      platform    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_occurred_idx
      ON brainstrike_diagnostic_events (occurred_at DESC);

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_fingerprint_idx
      ON brainstrike_diagnostic_events (fingerprint, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_thread_idx
      ON brainstrike_diagnostic_events (thread_id) WHERE thread_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_severity_idx
      ON brainstrike_diagnostic_events (severity, occurred_at DESC);

-- PostgreSQL migrations 76
CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_errors (
      run_id              TEXT PRIMARY KEY NOT NULL,
      thread_id           TEXT NOT NULL,
      resource_id         TEXT NOT NULL,
      code                TEXT NOT NULL,
      message             TEXT,
      cause_chain TEXT CHECK (cause_chain IS NULL OR json_valid(cause_chain)),
      http_status         INTEGER,
      provider_request_id TEXT,
      response_headers TEXT CHECK (response_headers IS NULL OR json_valid(response_headers)),
      occurred_at         TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CONSTRAINT bst_assistant_run_errors_run_check
        CHECK (length(run_id) > 0),
      CONSTRAINT bst_assistant_run_errors_thread_check
        CHECK (length(thread_id) > 0),
      CONSTRAINT bst_assistant_run_errors_resource_check
        CHECK (length(resource_id) > 0),
      CONSTRAINT bst_assistant_run_errors_code_check
        CHECK (length(code) > 0),
      CONSTRAINT bst_assistant_run_errors_cause_chain_check
        CHECK (cause_chain IS NULL OR json_type(cause_chain) = 'array'),
      CONSTRAINT bst_assistant_run_errors_http_status_check
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
      CONSTRAINT bst_assistant_run_errors_response_headers_check
        CHECK (response_headers IS NULL OR json_type(response_headers) = 'object')
    ) STRICT;

    CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_thread_idx
      ON brainstrike_assistant_run_errors (thread_id, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_resource_idx
      ON brainstrike_assistant_run_errors (resource_id, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_run_idx
      ON brainstrike_diagnostic_events (run_id, occurred_at DESC)
      WHERE run_id IS NOT NULL;

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

-- PostgreSQL migrations 80
CREATE TABLE IF NOT EXISTS brainstrike_assistant_message_tombstones (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      rewind_id TEXT NOT NULL,
      revert_id TEXT,
      tombstoned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_thread_idx
      ON brainstrike_assistant_message_tombstones (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_rewind_idx
      ON brainstrike_assistant_message_tombstones (rewind_id);

-- PostgreSQL migrations 81
CREATE TABLE IF NOT EXISTS brainstrike_workspace_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      root_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'turn-end', 'pre-revert')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_thread_idx
      ON brainstrike_workspace_snapshots (thread_id, created_at);

    CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_root_idx
      ON brainstrike_workspace_snapshots (root_id);

-- PostgreSQL migrations 86
CREATE TABLE IF NOT EXISTS brainstrike_token_estimate_calibration (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      estimated_prompt_tokens INTEGER NOT NULL CHECK (estimated_prompt_tokens >= 0),
      final_step_prompt_tokens INTEGER NOT NULL CHECK (final_step_prompt_tokens >= 0),
      step_count INTEGER NOT NULL DEFAULT 1 CHECK (step_count >= 1),
      model_visible_projection_count INTEGER NOT NULL DEFAULT 0 CHECK (model_visible_projection_count >= 0),
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_domain_budget_tokens INTEGER CHECK (resolved_domain_budget_tokens IS NULL OR resolved_domain_budget_tokens > 0),
      resolved_transport_budget_tokens INTEGER CHECK (resolved_transport_budget_tokens IS NULL OR resolved_transport_budget_tokens > 0),
      prompt_baseline_tokens INTEGER CHECK (prompt_baseline_tokens IS NULL OR prompt_baseline_tokens > 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_thread_idx
      ON brainstrike_token_estimate_calibration (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_model_idx
      ON brainstrike_token_estimate_calibration (model, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_occurred_at_idx
      ON brainstrike_token_estimate_calibration (occurred_at);

-- PostgreSQL migrations 88
CREATE TABLE IF NOT EXISTS brainstrike_assistant_compaction_ranges (
      compaction_message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      compacted_message_ids TEXT CHECK (compacted_message_ids IS NULL OR json_valid(compacted_message_ids)) NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agentic', 'deterministic')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_compaction_ranges_thread_idx
      ON brainstrike_assistant_compaction_ranges (thread_id);

-- PostgreSQL migrations 93
CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_treatments (
      run_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      experiment_id TEXT,
      variant TEXT,
      injection_status TEXT NOT NULL CHECK (
        injection_status IN ('continuation', 'injected', 'no_waste', 'preference_malformed', 'preference_off', 'query_failed')
      ),
      signal_injected INTEGER CHECK (signal_injected IN (0,1)) NOT NULL,
      signal_content_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CONSTRAINT brainstrike_assistant_run_treatments_injected_consistency
        CHECK (signal_injected = (injection_status = 'injected'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_treatments_created_at_idx
      ON brainstrike_assistant_run_treatments (created_at);

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

-- PostgreSQL migrations 118 run event compatibility ledger; absent legacy parent FKs omitted
CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
    ) STRICT;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_thread_idx
  ON brainstrike_assistant_run_events (thread_id, resource_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_run_idx
  ON brainstrike_assistant_run_events (run_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_pause_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id)
  WHERE kind = 'tool.approval.requested';

DROP INDEX IF EXISTS brainstrike_assistant_run_events_approval_answer_idx;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_answer_at_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id, (json_extract(metadata, '$.toolCallId')), occurred_at)
  WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');

-- PostgreSQL migrations 46,47,58,69,77,90,128,135 usage; absent delegation parent FKs omitted
CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_usage (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      root_id TEXT,
      billed_cost_usd TEXT CHECK (billed_cost_usd IS NULL OR (length(billed_cost_usd) > 0 AND billed_cost_usd NOT GLOB '*[^0-9.]*' AND billed_cost_usd NOT GLOB '*.*.*' AND billed_cost_usd GLOB '*[0-9]*')),
      cache_read_input_tokens INTEGER CHECK (cache_read_input_tokens >= 0),
      cache_creation_input_tokens INTEGER CHECK (cache_creation_input_tokens >= 0),
      run_kind TEXT NOT NULL DEFAULT 'chat' CHECK (run_kind IN ('chat','subagent','compaction-summary','om-observation','om-reflection')),
      delegation_parent_run_id TEXT,
      delegation_tool_call_id TEXT,
      continuation_id TEXT,
      CHECK ((delegation_parent_run_id IS NULL AND delegation_tool_call_id IS NULL) OR
        (delegation_parent_run_id IS NOT NULL AND delegation_tool_call_id IS NOT NULL AND
          length(trim(delegation_parent_run_id)) > 0 AND length(trim(delegation_tool_call_id)) > 0 AND run_kind = 'subagent'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_thread_idx
      ON brainstrike_assistant_run_usage (thread_id);
  CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_root_idx ON brainstrike_assistant_run_usage(resource_id, root_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_delegation_idx ON brainstrike_assistant_run_usage(thread_id, delegation_parent_run_id, delegation_tool_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_continuation_idx ON brainstrike_assistant_run_usage(continuation_id, run_id);
`;
