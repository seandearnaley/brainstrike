import {
  MASTRA_MEMORY_TABLES,
  MIND_OPS_TABLE,
  THREAD_DELETE_SIDECAR_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { DbHandle } from '@brainstrike/db/react';

export const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
/** Workspace roots (migration 039); joined by the cross-root usage rollup. */
const ROOTS_TABLE = 'roots';

export const LATEST_THREAD_RUNS_BY_RESOURCE_SQL = `SELECT DISTINCT ON (thread_id)
    id,
    resource_id,
    thread_id,
    provider,
    model,
    model_settings,
    provider_options,
    runtime_kind,
    status,
    error,
    started_at,
    completed_at,
    created_at,
    updated_at,
    turn_message_id
  FROM ${ASSISTANT_THREAD_RUNS_TABLE}
  WHERE resource_id = $1
  ORDER BY thread_id, started_at DESC, id DESC`;

export const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';

export const ASSISTANT_RUN_USAGE_TABLE = 'brainstrike_assistant_run_usage';

export const ASSISTANT_EDIT_CHECKPOINTS_TABLE = 'brainstrike_assistant_edit_checkpoints';

export const ASSISTANT_RUN_OUTCOMES_TABLE = 'brainstrike_assistant_run_outcomes';

export const ASSISTANT_MESSAGE_PARENTS_TABLE = 'brainstrike_assistant_message_parents';

/**
 * Every relation the repository reads or writes, and therefore every relation
 * whose absence means this database was never migrated.
 *
 * Read inside a function body, never at module scope: these are
 * `mastra-memory-schema` constants, and a module-scope read of them is the
 * BST-558 chunk-initialization hazard that
 * `scripts/verify-mastra-schema-init-order.mjs` guards.
 *
 * The thread-delete cascade references EVERY registered sidecar
 * unconditionally, so the sidecar list is derived rather than restated — a
 * sidecar added to the contract is probed the day it lands.
 */
export function requiredAssistantMemoryRelations(): readonly string[] {
  return [
    ...new Set([
      MASTRA_MEMORY_TABLES.threads,
      MASTRA_MEMORY_TABLES.messages,
      MASTRA_MEMORY_TABLES.observationalMemory,
      ASSISTANT_THREAD_RUNS_TABLE,
      ASSISTANT_RUN_EVENTS_TABLE,
      ASSISTANT_RUN_USAGE_TABLE,
      ASSISTANT_RUN_OUTCOMES_TABLE,
      ASSISTANT_EDIT_CHECKPOINTS_TABLE,
      MIND_OPS_TABLE,
      // `roots` is not assistant-owned (migration 039 creates it), but
      // CROSS_ROOT_USAGE_AGGREGATION_SQL reads it through `LEFT JOIN roots`.
      // Without it here, a handle carrying every assistant relation but no
      // roots table passes the probe and then raises a raw missing-relation
      // error from getCrossRootUsage() instead of the named one — the exact
      // inconsistent failure this probe exists to remove.
      ROOTS_TABLE,
      ...THREAD_DELETE_SIDECAR_TABLES.map((sidecar) => sidecar.table),
    ]),
  ].sort();
}

/**
 * Raised when the assistant memory schema is not present. Migrations 117/118
 * own that schema; nothing creates it at runtime any more.
 */
export class AssistantMemorySchemaMissingError extends Error {
  readonly missingRelations: readonly string[];

  constructor(missingRelations: readonly string[]) {
    super(
      `Assistant memory schema is incomplete: ${missingRelations.length} required relation(s) absent ` +
        `(${missingRelations.join(', ')}). This database was never migrated — run migrations before ` +
        'creating the assistant thread repository.'
    );
    this.name = 'AssistantMemorySchemaMissingError';
    this.missingRelations = missingRelations;
  }
}

/**
 * The schema check, and the reason it is a PROBE rather than a bootstrap.
 *
 * This repository used to `exec` a ~590-line `CREATE TABLE IF NOT EXISTS`
 * mirror of migrations 046-095 on first use per handle. On a migrated database
 * the `IF NOT EXISTS` never fired, which meant any divergence between the
 * mirror and the migrations was UNOBSERVABLE until a user hit a column the two
 * had shaped differently — a silent corruption with nothing pointing at its
 * cause. Migrations 117 (Mastra's memory schema) and 118 (the run header and
 * its event timeline) removed the last reason that mirror existed.
 *
 * `to_regclass` returns NULL for an absent relation instead of raising 42P01,
 * so one statement answers for the whole set and names exactly what is missing.
 * There is deliberately NO create-if-absent branch: a missing relation means
 * migrations did not run, and quietly creating it is precisely how the
 * divergence above was manufactured. The relation names are module constants
 * from `@brainstrike/assistant-contract`, never caller input, so inlining them
 * as literals carries no injection surface.
 */
export async function assertAssistantMemorySchema(database: DbHandle): Promise<void> {
  const relations = requiredAssistantMemoryRelations();
  const relationValues = relations.map((relation) => `('${relation}')`).join(', ');
  const result = await database.query<{ relation: string }>(
    `SELECT required.relation
       FROM (VALUES ${relationValues}) AS required(relation)
      WHERE to_regclass('public.' || required.relation) IS NULL
      ORDER BY required.relation`
  );
  if (result.rows.length === 0) {
    return;
  }
  throw new AssistantMemorySchemaMissingError(result.rows.map((row) => row.relation));
}
