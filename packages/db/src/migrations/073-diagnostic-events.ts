import type { Migration } from './migration-runner';

/**
 * Flight Recorder P1: durable app-wide diagnostic events (warn+).
 *
 * Cross-cutting store, deliberately SEPARATE from the run-scoped
 * `brainstrike_assistant_run_events` timeline (different scope, retention,
 * and sanitization contract — design doc §3C, "do not relitigate").
 *
 * NO foreign keys (run_usage 046 / run_outcomes 062 precedent): both
 * migration runners execute on a bare PGlite; correlation ids are nullable
 * text and orphans are inert. Retention is a bounded oldest-first purge in
 * DiagnosticEventsRepository (30d / 20k rows), NOT a trigger. Factory reset
 * purges explicitly (db-ipc OptionalRelationTable + web db-provider reset).
 */
export const migration073DiagnosticEvents: Migration = {
  down: `
    DROP INDEX IF EXISTS bst_diagnostic_events_severity_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_thread_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_fingerprint_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_occurred_idx;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_diagnostic_events;
  `,
  ledgerKey: 'custom-073-diagnostic-events',
  name: 'diagnostic_events',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_diagnostic_events (
      id          text PRIMARY KEY,
      occurred_at timestamptz NOT NULL,
      severity    text NOT NULL CHECK (severity IN ('warn','error','fatal')),
      source      text NOT NULL,
      scope       text,
      code        text,
      message     text NOT NULL,
      stack       text,
      cause_chain jsonb,
      context     jsonb,
      fingerprint text NOT NULL,
      session_id  text NOT NULL,
      run_id      text,
      thread_id   text,
      resource_id text,
      root_id     text,
      app_version text NOT NULL,
      platform    text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_occurred_idx
      ON brainstrike_diagnostic_events (occurred_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_fingerprint_idx
      ON brainstrike_diagnostic_events (fingerprint, occurred_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_thread_idx
      ON brainstrike_diagnostic_events (thread_id) WHERE thread_id IS NOT NULL;
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_severity_idx
      ON brainstrike_diagnostic_events (severity, occurred_at DESC);
  `,
  version: 73,
};
