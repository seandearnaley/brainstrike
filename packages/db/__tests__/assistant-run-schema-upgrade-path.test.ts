/**
 * The UPGRADE path for migrations 117/118 (BST-1651).
 *
 * Every relation those two migrations create already exists on every install
 * that has ever run the assistant: until this ticket they were created at
 * runtime, by `PgliteMemoryStore.initialize()` and by the repository's
 * `buildAssistantThreadRunsSchemaSql()` bootstrap mirror. So the interesting
 * database is not the fresh one — it is the one that already carries the
 * bootstrap's tables and is about to run 117 and 118 for the first time.
 *
 * A bare `CREATE TABLE` would error there, for every existing user. A plain
 * `CREATE TABLE IF NOT EXISTS` would skip, and whatever the bootstrap shaped
 * differently would survive forever — the exact silent drift this ticket
 * exists to delete, preserved on precisely the installs that matter. Neither
 * is acceptable, so the migrations must CONVERGE: skip the create, then apply
 * every difference explicitly, and prove it by comparing catalogs.
 *
 * That is what this test is. It seeds a database the way each era of the
 * bootstrap actually left it, runs the chain over it, and asserts the
 * resulting catalog is IDENTICAL — column ordinals, indexes and constraints
 * included — to a database migrated from empty. Column ordinal is in the
 * comparison deliberately: the drift this ticket found
 * (`brainstrike_assistant_tool_projection_rewrites.kind` at ordinal 5
 * bootstrapped, 8 migrated) was invisible to every other projection.
 *
 * The seeds are FROZEN HISTORY. They are verbatim copies of shipped bootstrap
 * SQL, identified by the commit that shipped them, and they must never be
 * edited to make this test pass — an install that ran that code has that
 * schema, and the only thing that may change is the forward migration.
 */
import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { customMigrations, splitMigrationStatements } from '../src/drizzle/migrate.js';
import migrationsManifest from '../src/drizzle/migrations.json' with { type: 'json' };
import { migrate } from '../src/migrations/bootstrap.js';
import { wasmLoader } from '../src/wasm-loader.js';

const MASTRA_MEMORY_MIGRATION_VERSION = 117;

/**
 * The bootstrap's run-table DDL as it shipped at BST-1163 (f0d3f134a,
 * 2026-08-06) — the FIRST era to carry `turn_message_id`, and the last before
 * the BST-1404 approval indexes. Table names are inlined; the source
 * interpolated them from constants.
 */
const BOOTSTRAP_SQL_BST_1163 = `
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_runs (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  model_settings jsonb,
  provider_options jsonb,
  runtime_kind text NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  turn_message_id text
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_resource_idx
  ON brainstrike_assistant_thread_runs (resource_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_thread_latest_idx
  ON brainstrike_assistant_thread_runs (resource_id, thread_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_status_idx
  ON brainstrike_assistant_thread_runs (status);

CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  label text NOT NULL,
  detail text,
  duration_ms integer,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_thread_idx
  ON brainstrike_assistant_run_events (thread_id, resource_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_run_idx
  ON brainstrike_assistant_run_events (run_id, sequence ASC, occurred_at ASC);
`;

/**
 * The BST-1115 era (ebbb085ce): NO `turn_message_id`. The bootstrap added it
 * with an `ALTER … ADD COLUMN IF NOT EXISTS` that re-ran on every handle init;
 * migration 118 is now that column's only upgrade path.
 */
const BOOTSTRAP_SQL_PRE_TURN_LINK = BOOTSTRAP_SQL_BST_1163.replace(
  '  updated_at timestamptz NOT NULL,\n  turn_message_id text\n);',
  '  updated_at timestamptz NOT NULL\n);'
);

/**
 * The BST-1404 era (ac9cb04c8): the approval indexes exist, but the anti-join
 * side trails `run_id` — the shape BST-1440 replaced because a call's pre-pause
 * start does not always share its pause's run. `CREATE INDEX IF NOT EXISTS`
 * keys off the NAME, so the rename IS the upgrade and the old name must be
 * dropped explicitly or this install keeps the wrong shape forever.
 */
const BOOTSTRAP_SQL_BST_1404 = `${BOOTSTRAP_SQL_BST_1163}
CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_pause_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id)
  WHERE kind = 'tool.approval.requested';

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_answer_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id, (metadata->>'toolCallId'), run_id)
  WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');
`;

/**
 * The bootstrap as it shipped immediately before this ticket retired it
 * (BST-1440 shape, `cba2bf493^`) — what an install updated on the day 117/118
 * land actually has. Migration 118 must be a total no-op against it.
 */
const BOOTSTRAP_SQL_CURRENT = `${BOOTSTRAP_SQL_BST_1163}
CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_pause_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id)
  WHERE kind = 'tool.approval.requested';

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_answer_at_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id, (metadata->>'toolCallId'), occurred_at)
  WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');
`;

/** The exact relations 117/118 own. Later migrations (133 background tasks)
 * must not be mistaken for changes made by the historical bootstrap. */
const OWNED_RELATION_PREDICATE = `(
  name IN ('mastra_threads', 'mastra_messages', 'mastra_resources', 'mastra_observational_memory', 'mastra_vectors', 'mastra_workflow_snapshot')
  OR name IN ('brainstrike_assistant_thread_runs', 'brainstrike_assistant_run_events')
)`;

interface CatalogSnapshot {
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
}

const COLUMNS_SQL = `
  SELECT entry FROM (
    SELECT table_name AS name,
           table_name || '.' || column_name
             || ' #' || ordinal_position
             || ' ' || data_type
             || ' nullable=' || is_nullable
             || ' default=' || COALESCE(column_default, '-') AS entry
    FROM information_schema.columns
    WHERE table_schema = 'public'
  ) AS c
  WHERE ${OWNED_RELATION_PREDICATE}
  ORDER BY entry`;

const INDEXES_SQL = `
  SELECT entry FROM (
    SELECT tablename AS name, indexdef AS entry
    FROM pg_indexes
    WHERE schemaname = 'public'
  ) AS i
  WHERE ${OWNED_RELATION_PREDICATE}
  ORDER BY entry`;

const CONSTRAINTS_SQL = `
  SELECT entry FROM (
    SELECT rel.relname AS name,
           rel.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) AS entry
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
  ) AS k
  WHERE ${OWNED_RELATION_PREDICATE}
  ORDER BY entry`;

async function snapshotOwnedCatalog(db: PGlite): Promise<CatalogSnapshot> {
  const columns = await db.query<{ entry: string }>(COLUMNS_SQL);
  const indexes = await db.query<{ entry: string }>(INDEXES_SQL);
  const constraints = await db.query<{ entry: string }>(CONSTRAINTS_SQL);
  return {
    columns: columns.rows.map((row) => row.entry),
    constraints: constraints.rows.map((row) => row.entry),
    indexes: indexes.rows.map((row) => row.entry),
  };
}

/**
 * Applies the chain up to (but excluding) `stopBeforeVersion`, exactly the way
 * `runMigrations` does — same statement splitting, same `__drizzle_migrations`
 * ledger rows — so the resumed run afterwards is a real resume rather than a
 * replay. The drizzle-snapshot manifest is entirely pre-117, so all of it
 * applies; only the derived custom migrations are filtered.
 */
async function migrateChainUpTo(db: PGlite, stopBeforeVersion: number): Promise<void> {
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    )`);
  const pending = [
    ...migrationsManifest.migrations,
    ...customMigrations.filter((migration) => Number(migration.version) < stopBeforeVersion),
  ];
  for (const migration of pending) {
    for (const statement of splitMigrationStatements(migration.sql)) {
      await db.query(statement);
    }
    await db.query('INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)', [migration.hash]);
  }
}

/**
 * A database as an existing install has it the moment before 117/118 run: the
 * chain through 116, then the runtime schema the app stood up on top of it —
 * Mastra's memory DDL (which `PgliteMemoryStore.initialize()` executes) and the
 * repository's own run-table bootstrap for the requested era.
 */
async function seedBootstrappedDatabase(bootstrapSql: string, name: string): Promise<PGlite> {
  const db = await wasmLoader.createPGlite(`memory://${name}`);
  await migrateChainUpTo(db, MASTRA_MEMORY_MIGRATION_VERSION);
  await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
  await db.exec(bootstrapSql);
  return db;
}

async function columnExists(db: PGlite, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ found: number }>(
    `SELECT COUNT(*)::int AS found
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return (result.rows[0]?.found ?? 0) > 0;
}

async function indexNames(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [table]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migrations 117/118: a bootstrapped database upgrades to the fresh shape', () => {
  let freshCatalog: CatalogSnapshot;

  beforeEach(async () => {
    const fresh = await wasmLoader.createPGlite('memory://bst1651-upgrade-fresh');
    try {
      await migrate(fresh);
      freshCatalog = await snapshotOwnedCatalog(fresh);
      // Control: an empty scrape would make every comparison below vacuous.
      expect(freshCatalog.columns.length).toBeGreaterThan(60);
      expect(freshCatalog.indexes.length).toBeGreaterThan(10);
      expect(freshCatalog.constraints.length).toBeGreaterThan(5);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it('converges the current bootstrap shape without touching a single relation', async () => {
    const db = await seedBootstrappedDatabase(BOOTSTRAP_SQL_CURRENT, 'bst1651-upgrade-current');
    try {
      const before = await snapshotOwnedCatalog(db);
      await migrate(db);
      expect(await snapshotOwnedCatalog(db)).toEqual(freshCatalog);
      // The bootstrap's own shape already matched everything 117/118 own, so
      // this era proves those migrations are a no-op where they must be — not
      // that they repair. Migration 140 is the one LATER change to a relation
      // they own: it appends `generation_run_id`, which no bootstrap era had,
      // so the pre-migration catalog differs by exactly that column.
      expect(before).toEqual({
        ...freshCatalog,
        columns: freshCatalog.columns.filter((entry) => !entry.includes('generation_run_id')),
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it('adds turn_message_id to a pre-BST-1163 install instead of skipping it', async () => {
    const db = await seedBootstrappedDatabase(
      BOOTSTRAP_SQL_PRE_TURN_LINK,
      'bst1651-upgrade-pre-turn-link'
    );
    try {
      // Control: without this the assertion below could pass vacuously.
      expect(await columnExists(db, 'brainstrike_assistant_thread_runs', 'turn_message_id')).toBe(
        false
      );

      await migrate(db);

      expect(await columnExists(db, 'brainstrike_assistant_thread_runs', 'turn_message_id')).toBe(
        true
      );
      expect(await snapshotOwnedCatalog(db)).toEqual(freshCatalog);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('replaces the pre-BST-1440 approval-answer index rather than leaving its shape', async () => {
    const db = await seedBootstrappedDatabase(BOOTSTRAP_SQL_BST_1404, 'bst1651-upgrade-pre-1440');
    try {
      // Control: the old name is present and the new one is not.
      const before = await indexNames(db, 'brainstrike_assistant_run_events');
      expect(before).toContain('brainstrike_assistant_run_events_approval_answer_idx');
      expect(before).not.toContain('brainstrike_assistant_run_events_approval_answer_at_idx');

      await migrate(db);

      const after = await indexNames(db, 'brainstrike_assistant_run_events');
      expect(after).not.toContain('brainstrike_assistant_run_events_approval_answer_idx');
      expect(after).toContain('brainstrike_assistant_run_events_approval_answer_at_idx');
      expect(await snapshotOwnedCatalog(db)).toEqual(freshCatalog);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('converges a pre-approval-index install that never had either partial index', async () => {
    const db = await seedBootstrappedDatabase(
      BOOTSTRAP_SQL_PRE_TURN_LINK,
      'bst1651-upgrade-pre-1404'
    );
    try {
      const before = await indexNames(db, 'brainstrike_assistant_run_events');
      expect(before).not.toContain('brainstrike_assistant_run_events_approval_pause_idx');

      await migrate(db);

      expect(await indexNames(db, 'brainstrike_assistant_run_events')).toContain(
        'brainstrike_assistant_run_events_approval_pause_idx'
      );
      expect(await snapshotOwnedCatalog(db)).toEqual(freshCatalog);
    } finally {
      await db.close();
    }
  }, 60_000);
});
