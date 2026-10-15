import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number;
}

interface NameRow {
  name: string;
}

/**
 * Migration 074 creates the non-superuser role that is one of the four
 * independent layers of the agent SQL sandbox. See
 * `docs/agents/agent-self-query.md`.
 */
describe('migration 074: agent read-only role', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(73);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration074() {
    const migration = migrations.find((candidate) => candidate.version === 74);
    if (!migration) {
      throw new Error('Migration 074 is missing');
    }
    return migration;
  }

  it('creates a NOLOGIN, non-superuser role', { timeout: 120_000 }, async () => {
    await runner.runMigration(getMigration074());

    const role = await db.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
    }>(`SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly'`);

    expect(role.rows).toHaveLength(1);
    // Both flags are load-bearing: superuser would defeat the function-privilege
    // layer entirely, and LOGIN would make the role a real connection identity.
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolcanlogin).toBe(false);
  });

  it('is idempotent when re-run', { timeout: 120_000 }, async () => {
    const migration = getMigration074();
    await runner.runMigration(migration);

    // The dual-runner design means the same SQL can execute twice on one store.
    // CREATE ROLE has no IF NOT EXISTS, so this would throw without the guard.
    const up = typeof migration.up === 'string' ? migration.up : null;
    if (up === null) {
      throw new Error('Migration 074 must be plain SQL');
    }
    await expect(db.exec(up)).resolves.toBeDefined();
  });

  it('grants SELECT on every existing public table', { timeout: 120_000 }, async () => {
    await runner.runMigration(getMigration074());

    // Tripwire: this is the guard that fails loudly the day a future migration
    // adds a table the role cannot read. ALTER DEFAULT PRIVILEGES should cover
    // it, but we prove it rather than assume it.
    // Privilege checks go through the OID, not a formatted name: the planner
    // is free to evaluate has_table_privilege() before the schema filter, and
    // a name-based check then tries to resolve catalog tables in `public`.
    const ungranted = await db.query<NameRow>(
      `SELECT c.relname AS name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND NOT has_table_privilege('brainstrike_agent_readonly', c.oid, 'SELECT')
          ORDER BY c.relname`
    );

    expect(ungranted.rows.map((row) => row.name)).toEqual([]);
  });

  it('grants SELECT on tables created after the migration', { timeout: 120_000 }, async () => {
    await runner.runMigration(getMigration074());

    // Stand-in for a future numbered migration adding a table.
    await db.exec('CREATE TABLE bst_future_table (id int)');

    const granted = await db.query<CountRow>(
      `SELECT has_table_privilege('brainstrike_agent_readonly',
                                    'public.bst_future_table', 'SELECT')::int AS count`
    );

    expect(Number(granted.rows[0]?.count ?? 0)).toBe(1);
  });

  it('grants USAGE on the public schema', { timeout: 120_000 }, async () => {
    await runner.runMigration(getMigration074());

    const usage = await db.query<CountRow>(
      `SELECT has_schema_privilege('brainstrike_agent_readonly', 'public', 'USAGE')::int AS count`
    );

    expect(Number(usage.rows[0]?.count ?? 0)).toBe(1);
  });
});
