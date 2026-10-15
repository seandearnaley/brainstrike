import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the roots table and its relationship to file_records.
 *
 * Was migration-039's suite, plus migration-111's kind vocabulary. Dropped: "creates one legacy root per distinct
 * source_root_path and backfills root_id", which cannot be expressed at all any
 * more -- migration 040 dropped `file_records.source_root_path`, and a
 * greenfield install has no legacy rows to convert (ADR-0020) -- and "rollback
 * removes roots artifacts", because ADR-0020 does not build rollback.
 *
 * Kept: per-root cache identity and the ON DELETE CASCADE. The catalog fixture
 * records that `idx_file_records_root_identity` and `file_records_root_id_fkey`
 * exist; only a duplicate INSERT and a real DELETE show they ENFORCE anything.
 */
describe('roots', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedRoot(displayName: string, path: string): Promise<string> {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO roots (kind, display_name, path) VALUES ('legacy', $1, $2) RETURNING id`,
      [displayName, path]
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      throw new Error('roots INSERT returned no id');
    }
    return id;
  }

  async function seedFileRecord(id: string, path: string, rootId: string): Promise<void> {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, embedding_set_id, root_id)
       VALUES ($1, $2, $3, 0, 'set-a', $4)`,
      [id, path.split('/').pop() ?? path, path, rootId]
    );
  }

  it('enforces per-root cache identity and cascades file deletion on root removal', async () => {
    const workRootId = await seedRoot('work-docs', '/Users/alice/work-docs');
    const personalRootId = await seedRoot('personal-docs', '/Users/alice/personal-docs');
    await seedFileRecord('f1', 'src/index.ts', workRootId);
    await seedFileRecord('f2', 'src/index.ts', personalRootId);

    // The same (embedding_set_id, path) from two different roots coexists.
    const distinctRoots = await db.query<{ count: number | string }>(
      `SELECT COUNT(DISTINCT root_id)::int AS count FROM file_records WHERE path = 'src/index.ts'`
    );
    expect(Number(distinctRoots.rows[0]?.count ?? 0)).toBe(2);

    // A duplicate (embedding_set_id, root_id, path) is rejected.
    await expect(seedFileRecord('f-dup', 'src/index.ts', workRootId)).rejects.toThrow(
      /duplicate key/
    );

    // Deleting a root cascades to its file records and nobody else's.
    await db.query('DELETE FROM roots WHERE id = $1', [workRootId]);
    const remaining = await db.query<{ id: string }>('SELECT id FROM file_records ORDER BY id');
    expect(remaining.rows.map((row) => row.id)).toEqual(['f2']);
  });

  it('accepts every supported root kind and rejects an unknown one', async () => {
    // Was migration-111's suite. `worktree` joined the closed vocabulary there;
    // the fixture records the CHECK's expression, but only an INSERT shows it
    // admits the kinds the product actually creates and refuses the rest.
    for (const kind of ['path', 'worktree'] as const) {
      await db.query('INSERT INTO roots (kind, display_name, path) VALUES ($1, $1, $2)', [
        kind,
        `/managed/${kind}`,
      ]);
    }

    await expect(
      db.query(
        `INSERT INTO roots (kind, display_name, path)
         VALUES ('unknown', 'unknown', '/managed/unknown')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('defaults a new root to a generated id and live status', async () => {
    const rootId = await seedRoot('fresh', '/Users/alice/fresh');

    const rows = await db.query<{ created_at: unknown; id: string; status: string }>(
      'SELECT id, status, created_at FROM roots WHERE id = $1',
      [rootId]
    );
    expect(rows.rows[0]?.status).toBe('live');
    expect(rows.rows[0]?.id).toHaveLength(36);
    expect(rows.rows[0]?.created_at).toBeTruthy();
  });
});
