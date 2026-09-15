import type { Migration } from './migration-runner.js';

/**
 * Swarm-run evidence for the thread debug pack: what each leg/child was told,
 * what woke the parent, and every live decision with its outcome. Append-only,
 * host-written, never runtime authority. All three cascade from the host run
 * (which cascades from mastra_threads via migration 118), so factory reset and
 * thread deletion need no separate clear (see RESET_EXCLUDED_TABLES).
 */
export const migration139SwarmDiagnostics: Migration = {
  down: `DROP TABLE IF EXISTS brainstrike_delegated_live_decisions;
    DROP TABLE IF EXISTS brainstrike_delegated_wakeups;
    DROP TABLE IF EXISTS brainstrike_assistant_prompt_manifests;`,
  ledgerKey: 'custom-139-swarm-diagnostics',
  name: 'swarm_diagnostics',
  up: `CREATE TABLE IF NOT EXISTS brainstrike_assistant_prompt_manifests (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    thread_id text NOT NULL CHECK (length(btrim(thread_id)) > 0),
    kind text NOT NULL CHECK (kind IN ('root-leg', 'child-first-step', 'continuation')),
    native_run_id text,
    parent_tool_call_id text,
    persona_id text,
    provider text,
    model text,
    system_context_source text NOT NULL CHECK (system_context_source IN ('captured', 'root-leg', 'none')),
    system_messages jsonb NOT NULL,
    persona_instructions text,
    delegation_prompt text,
    tool_names jsonb NOT NULL,
    total_chars integer NOT NULL CHECK (total_chars >= 0),
    truncated boolean NOT NULL DEFAULT FALSE,
    created_at timestamptz NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS brainstrike_assistant_prompt_manifests_run_idx
    ON brainstrike_assistant_prompt_manifests(host_run_id, created_at);
  CREATE TABLE IF NOT EXISTS brainstrike_delegated_wakeups (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    root_thread_id text NOT NULL CHECK (length(btrim(root_thread_id)) > 0),
    kind text NOT NULL CHECK (kind IN ('idle-loop', 'resume-leg', 'late-overlay', 'deferred')),
    directive text NOT NULL,
    invocations jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS brainstrike_delegated_wakeups_run_idx
    ON brainstrike_delegated_wakeups(host_run_id, created_at);
  CREATE TABLE IF NOT EXISTS brainstrike_delegated_live_decisions (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    root_thread_id text NOT NULL CHECK (length(btrim(root_thread_id)) > 0),
    task_id text,
    tool_call_id text NOT NULL CHECK (length(btrim(tool_call_id)) > 0),
    delegation_tool_call_id text,
    tool_name text,
    kind text NOT NULL CHECK (kind IN ('approval', 'resume')),
    decision text CHECK (decision IN ('approve', 'decline', 'resume')),
    source text NOT NULL CHECK (source IN ('user', 'remembered-grant')),
    outcome text NOT NULL CHECK (outcome IN ('delivered', 'no-live-run', 'refused', 'failed', 'remembered-answered', 'remembered-failed')),
    reason text,
    answered_sibling_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    policy_snapshot jsonb,
    occurred_at timestamptz NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS brainstrike_delegated_live_decisions_run_idx
    ON brainstrike_delegated_live_decisions(host_run_id, occurred_at);`,
  version: 139,
};
