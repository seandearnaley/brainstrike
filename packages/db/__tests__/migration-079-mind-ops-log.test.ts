import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

describe('migration 079: mind ops log (BST-993)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(78);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration079() {
    const migration = migrations.find((candidate) => candidate.version === 79);
    if (!migration) {
      throw new Error('Migration 079 is missing');
    }
    return migration;
  }

  it('creates the append-only op-log with its entity index', async () => {
    await runner.runMigration(getMigration079());

    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = 'brainstrike_mind_ops'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const index = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_mind_ops'`
    );
    expect(index.rows.map((row) => row.indexname)).toContain('brainstrike_mind_ops_entity_idx');
  });

  it('assigns monotonic local seq and defaults occurred_at', async () => {
    await runner.runMigration(getMigration079());

    await db.query(
      `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op, resource_id)
       VALUES ('thread', 'thread-a', 'delete', 'workspace-a'),
              ('prompt_item', 'prompt-b', 'delete', NULL)`
    );
    const rows = await db.query<{
      seq: string | number;
      occurred_at: unknown;
      resource_id: string | null;
    }>('SELECT seq, occurred_at, resource_id FROM brainstrike_mind_ops ORDER BY seq');
    expect(rows.rows).toHaveLength(2);
    expect(Number(rows.rows[1]?.seq)).toBeGreaterThan(Number(rows.rows[0]?.seq));
    expect(rows.rows[0]?.occurred_at).toBeTruthy();
    // Thread tombstones carry workspace scope (unrecoverable post-delete);
    // prompt items are global, so resource_id is nullable.
    expect(rows.rows[0]?.resource_id).toBe('workspace-a');
    expect(rows.rows[1]?.resource_id).toBeNull();
  });

  it('rejects vocabulary outside the seam contract (deliberate CHECKs)', async () => {
    await runner.runMigration(getMigration079());

    // Widening op/entity vocabulary must be a conscious migration when a
    // sync engine is chosen — not a silent drift channel (NO SILENT
    // FALLBACKS).
    await expect(
      db.query(
        `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op)
         VALUES ('thread', 'thread-a', 'upsert')`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op)
         VALUES ('vector', 'v-1', 'delete')`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
