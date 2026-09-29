import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { McpTaskRepository } from '../src/repositories/mcp-task-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TASKS_TABLE = 'brainstrike_mcp_tasks';
const AUTHORITY_TABLE = 'brainstrike_mcp_task_authorities';
const SERVER_ID = 'linear';
const RESOURCE = 'https://mcp.linear.app/mcp';
const PRINCIPAL_ID = 'linear:user-42';

function getMigration(version: number) {
  const migration = migrations.find((candidate) => candidate.version === version);
  if (!migration) {
    throw new Error(`Migration ${version} is missing`);
  }
  return migration;
}

async function insertLegacyTask(db: PGlite, generation: number, taskId: string, at: string) {
  await db.query(
    `INSERT INTO ${TASKS_TABLE} (
       server_id, resource, principal_id, generation, task_id, status,
       history, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'working', $6::jsonb, $7::timestamptz, $7::timestamptz)`,
    [
      SERVER_ID,
      RESOURCE,
      PRINCIPAL_ID,
      generation,
      taskId,
      JSON.stringify([{ at, status: 'working' }]),
      at,
    ]
  );
}

describe('migration 115: durable MCP task authority', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      createPGliteTestDataDir('pglite-mcp-task-authority-migration')
    );
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 115));
  });

  afterEach(async () => {
    await db.close();
  });

  it('backfills generations without resurrecting an older Desktop host after restart', async () => {
    await insertLegacyTask(db, 1, 'retired-task', '2026-08-31T10:00:00.000Z');
    await insertLegacyTask(db, 7, 'live-task', '2026-08-31T11:00:00.000Z');

    await runner.runMigration(getMigration(115));

    const authorities = await db.query<{
      authority_epoch: string;
      connection_generation: number;
      retired_at: Date | null;
      runtime_id: string;
    }>(
      `SELECT authority_epoch, connection_generation, retired_at, runtime_id
       FROM ${AUTHORITY_TABLE}
       ORDER BY connection_generation`
    );
    expect(authorities.rows).toHaveLength(2);
    expect(authorities.rows[0]).toMatchObject({
      connection_generation: 1,
      retired_at: expect.any(Date),
      runtime_id: 'migration-115-recovered',
    });
    expect(authorities.rows[1]).toMatchObject({
      connection_generation: 7,
      retired_at: null,
      runtime_id: 'migration-115-recovered',
    });

    const repository = new McpTaskRepository(db);
    const restartedAuthority = await repository.openAuthority({
      connectionGeneration: 1,
      principalId: PRINCIPAL_ID,
      resource: RESOURCE,
      runtimeId: 'desktop-runtime-after-restart',
      serverId: SERVER_ID,
    });
    expect(restartedAuthority.authorityEpoch).toBe(authorities.rows[1]?.authority_epoch);
    await expect(repository.listActive(restartedAuthority)).resolves.toMatchObject([
      { taskId: 'live-task' },
    ]);
    await expect(
      repository.get({
        authorityEpoch: restartedAuthority.authorityEpoch,
        principalId: PRINCIPAL_ID,
        resource: RESOURCE,
        serverId: SERVER_ID,
        taskId: 'retired-task',
      })
    ).resolves.toBeNull();

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = '${TASKS_TABLE}'`
    );
    expect(columns.rows.map(({ column_name }) => column_name)).not.toContain('generation');
    expect(columns.rows.map(({ column_name }) => column_name)).toContain('authority_epoch');
  });

  it('rolls back only when every durable row is representable by migration 114', async () => {
    await insertLegacyTask(db, 7, 'live-task', '2026-08-31T11:00:00.000Z');
    const migration = getMigration(115);
    await runner.runMigration(migration);

    await runner.rollback(migration);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = '${TASKS_TABLE}'`
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toContain('generation');
    const authorities = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = '${AUTHORITY_TABLE}'`
    );
    expect(authorities.rows).toEqual([{ count: 0 }]);
  });
});

describe('migration 115 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => {
    await db.close();
  });

  it('registers the authority upgrade in the production migration path', {
    timeout: 300_000,
  }, async () => {
    await expect(runMigrations(db)).resolves.toMatchObject({ success: true });
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = '${TASKS_TABLE}'`
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toContain('authority_epoch');
    const authorities = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = '${AUTHORITY_TABLE}'`
    );
    expect(authorities.rows).toEqual([{ count: 1 }]);
  });
});
