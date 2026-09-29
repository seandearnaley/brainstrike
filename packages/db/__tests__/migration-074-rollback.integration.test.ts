import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration074AgentReadonlyRole } from '../src/migrations/074-agent-readonly-role.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 074 rollback semantics', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('rollback-074'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(`
      CREATE TABLE rollback_user_data (id integer PRIMARY KEY, content text NOT NULL);
      INSERT INTO rollback_user_data VALUES (1, 'retain this user content');
      CREATE ROLE rollback_plain_role NOLOGIN;
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  async function expectUserData(): Promise<void> {
    const result = await db.query<{ content: string; id: number }>(
      'SELECT id, content FROM rollback_user_data'
    );
    expect(result.rows).toEqual([{ content: 'retain this user content', id: 1 }]);
  }

  async function expectFunctionRevocations(): Promise<void> {
    const result = await db.query<{ allowed: boolean; function: string }>(`
      SELECT signature AS function,
             has_function_privilege('rollback_plain_role', signature, 'EXECUTE') AS allowed
        FROM unnest(ARRAY[
          'pg_sleep(double precision)', 'pg_sleep_for(interval)',
          'pg_sleep_until(timestamp with time zone)', 'set_config(text,text,boolean)'
        ]) AS signature
       ORDER BY signature
    `);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => !row.allowed)).toBe(true);
  }

  it('removes only the sandbox role and restores its grants on reapplication', async () => {
    await runner.rollback(migration074AgentReadonlyRole);
    expect(await runner.isApplied(74)).toBe(false);
    const roles = await db.query<{ rolname: string }>(`
      SELECT rolname FROM pg_roles
       WHERE rolname IN ('brainstrike_agent_readonly', 'rollback_plain_role')
    `);
    expect(roles.rows).toEqual([{ rolname: 'rollback_plain_role' }]);
    await expectUserData();
    await expectFunctionRevocations();
    await expect(db.exec('SET ROLE brainstrike_agent_readonly')).rejects.toThrow('does not exist');

    // Exercise the SQL's own IF EXISTS guard, not the runner's ledger skip.
    if (typeof migration074AgentReadonlyRole.down !== 'string') {
      throw new Error('Migration 074 must have a SQL rollback');
    }
    await db.exec(migration074AgentReadonlyRole.down);
    await runner.runMigration(migration074AgentReadonlyRole);
    expect(await runner.isApplied(74)).toBe(true);
    await db.exec('CREATE TABLE rollback_future_table (id integer)');
    const grants = await db.query<{
      existing: boolean;
      future: boolean;
      rolcanlogin: boolean;
      rolsuper: boolean;
      usage: boolean;
    }>(`
      SELECT rolsuper, rolcanlogin,
        has_schema_privilege(rolname, 'public', 'USAGE') AS usage,
        has_table_privilege(rolname, 'rollback_user_data', 'SELECT') AS existing,
        has_table_privilege(rolname, 'rollback_future_table', 'SELECT') AS future
      FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly'
    `);
    expect(grants.rows).toEqual([
      { existing: true, future: true, rolcanlogin: false, rolsuper: false, usage: true },
    ]);
    await expectUserData();
    await expectFunctionRevocations();
    await db.exec("INSERT INTO rollback_user_data VALUES (2, 'postgres still writes')");
  });

  it('retains the role, grants, data and ledger when an unexpected dependency blocks DROP', async () => {
    await db.exec(`
      CREATE SCHEMA rollback_dependency;
      GRANT USAGE ON SCHEMA rollback_dependency TO brainstrike_agent_readonly;
    `);
    await expect(runner.rollback(migration074AgentReadonlyRole)).rejects.toThrow(
      'cannot be dropped because some objects depend on it'
    );
    expect(await runner.isApplied(74)).toBe(true);
    const grants = await db.query<{ existing: boolean; future: boolean; usage: boolean }>(`
      SELECT
        has_schema_privilege('brainstrike_agent_readonly', 'public', 'USAGE') AS usage,
        has_table_privilege('brainstrike_agent_readonly', 'rollback_user_data', 'SELECT') AS existing,
        EXISTS (
          SELECT 1 FROM pg_default_acl d,
            LATERAL aclexplode(d.defaclacl) a
          WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly')
            AND a.privilege_type = 'SELECT'
        ) AS future
    `);
    expect(grants.rows).toEqual([{ existing: true, future: true, usage: true }]);
    await expectUserData();
    await expectFunctionRevocations();
    await db.exec('REVOKE USAGE ON SCHEMA rollback_dependency FROM brainstrike_agent_readonly');
    await runner.rollback(migration074AgentReadonlyRole);
    expect(await runner.isApplied(74)).toBe(false);
    await expectUserData();
  });
});
