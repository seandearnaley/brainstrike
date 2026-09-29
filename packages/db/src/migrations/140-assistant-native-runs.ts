import type { Migration } from './migration-runner.js';

/**
 * ONE TURN, ONE LEDGER (BST-1749, PR #3198 review item 5; owner ruling
 * 2026-09-15). The delegation ledger is scoped to a GENERATION — the initial
 * send or regeneration that opened it — so every leg of that generation
 * publishes its rows under one identity and counts the same invocations. A
 * regeneration of the same prompt is its OWN generation, which is why the turn
 * anchor (`turn_message_id`, shared by every generation of a prompt) cannot be
 * that identity.
 *
 * `generation_run_id` names the host run that OPENED the generation: an
 * initial or regeneration leg references itself, and an approval/resume leg
 * inherits the generation of the leg whose paused run it continues. Rows that
 * predate this migration are backfilled to their OWN id — a generation opened
 * before 140 is one leg as far as the ledger is concerned. NULL is reserved
 * for a leg whose paused native run no host leg mapped (a delegated child run
 * header, or a pause parked before this migration); the ledger throws there
 * rather than guess a generation. The backfill is `WHERE generation_run_id IS
 * NULL`, so a REPLAY — tests only, since production applies each migration
 * once through the Drizzle ledger — would also stamp a later NULL row.
 *
 * `brainstrike_assistant_native_runs` is the mapping that makes the resume
 * side derivable at all: Mastra mints its own run ids and an approval or
 * suspension opens a NEW host leg, so a paused native run cannot otherwise be
 * traced back to the leg that started it. The host records one row per native
 * ROOT run it starts (the first turn and every continuation). Rows cascade
 * with the host leg, which already cascades from `mastra_threads`, so factory
 * reset and thread deletion need no separate clear (see RESET_EXCLUDED_TABLES).
 */
export const migration140AssistantNativeRuns: Migration = {
  down: `DROP TABLE IF EXISTS brainstrike_assistant_native_runs;
    ALTER TABLE brainstrike_assistant_thread_runs DROP COLUMN IF EXISTS generation_run_id;`,
  ledgerKey: 'custom-140-assistant-native-runs',
  name: 'assistant_native_runs',
  up: `ALTER TABLE brainstrike_assistant_thread_runs
    ADD COLUMN IF NOT EXISTS generation_run_id text;
  UPDATE brainstrike_assistant_thread_runs
    SET generation_run_id = id WHERE generation_run_id IS NULL;
  CREATE TABLE IF NOT EXISTS brainstrike_assistant_native_runs (
    native_run_id text PRIMARY KEY CHECK (length(btrim(native_run_id)) > 0),
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS brainstrike_assistant_native_runs_host_run_idx
    ON brainstrike_assistant_native_runs (host_run_id);`,
  version: 140,
};
