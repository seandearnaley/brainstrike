// @vitest-environment node
import type { DbHandle } from '@brainstrike/db/react';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import {
  createQuerySelectionSnapshot,
  loadQuerySelectionSnapshot,
} from '../query-selection-snapshot';

it('rolls back a failed snapshot without rolling back an interleaving writer', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE selection_snapshots (
        id UUID PRIMARY KEY DEFAULT uuidv7(), expires_at TIMESTAMPTZ
      );
      CREATE TABLE selection_snapshot_files (
        snapshot_id UUID REFERENCES selection_snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL, UNIQUE (snapshot_id, file_path)
      );
      CREATE TABLE unrelated_writes (id INTEGER PRIMARY KEY);
    `);
    const expired = await db.query<{ id: string }>(
      "INSERT INTO selection_snapshots (expires_at) VALUES (NOW() - INTERVAL '1 hour') RETURNING id"
    );
    const handle: DbHandle = {
      query: async <T>(sql: string, params?: unknown[]) => {
        try {
          return await db.query<T>(sql, params);
        } finally {
          if (sql.includes('INSERT INTO selection_snapshots')) {
            // This is another admitted writer, not a snapshot transaction member.
            await db.query('INSERT INTO unrelated_writes VALUES (1)');
          }
        }
      },
    };
    await expect(createQuerySelectionSnapshot(handle, ['same.ts', 'same.ts'])).rejects.toThrow();
    expect((await db.query('SELECT * FROM unrelated_writes')).rows).toEqual([{ id: 1 }]);
    expect((await db.query('SELECT id FROM selection_snapshots')).rows).toEqual(expired.rows);
    expect((await db.query('SELECT * FROM selection_snapshot_files')).rows).toEqual([]);
  } finally {
    await db.close();
  }
});

it('commits all 501 memberships and expires old snapshots atomically', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE selection_snapshots (
        id UUID PRIMARY KEY DEFAULT uuidv7(), expires_at TIMESTAMPTZ
      );
      CREATE TABLE selection_snapshot_files (
        snapshot_id UUID REFERENCES selection_snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL, UNIQUE (snapshot_id, file_path)
      );
      INSERT INTO selection_snapshots (expires_at) VALUES (NOW() - INTERVAL '1 hour');
    `);
    const handle: DbHandle = { query: db.query.bind(db) };
    const paths = Array.from({ length: 501 }, (_, i) => `file-${i}.ts`);
    const id = await createQuerySelectionSnapshot(handle, paths);
    expect(id).toBeTypeOf('string');
    if (!id) {
      throw new Error('Snapshot creation returned no id');
    }
    expect(new Set(await loadQuerySelectionSnapshot(handle, id))).toEqual(new Set(paths));
    expect((await db.query('SELECT id FROM selection_snapshots')).rows).toEqual([{ id }]);
  } finally {
    await db.close();
  }
});
