import type { Migration } from './migration-runner.js';

/** Literal mirror avoids module-initialization reads; catalog parity pins the contract. */
export const migration133MastraBackgroundTasks: Migration = {
  down: 'DROP TABLE IF EXISTS mastra_background_tasks;',
  ledgerKey: 'custom-133-mastra-background-tasks',
  name: 'mastra_background_tasks',
  up: `
CREATE TABLE IF NOT EXISTS mastra_background_tasks (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT,
  resource_id TEXT,
  status TEXT NOT NULL,
  args JSONB NOT NULL,
  result JSONB,
  error JSONB,
  suspend_payload JSONB,
  retry_count INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "suspendedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ
);
ALTER TABLE mastra_background_tasks ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_mastra_background_tasks_thread
  ON mastra_background_tasks (resource_id, thread_id, "createdAt", id);
CREATE INDEX IF NOT EXISTS idx_mastra_background_tasks_status
  ON mastra_background_tasks (status, agent_id);
`,
  version: 133,
};
