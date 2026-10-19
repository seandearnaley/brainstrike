// @vitest-environment node
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  type ScheduledDbHandle,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import {
  createQuerySelectionSnapshot,
  loadQuerySelectionSnapshot,
} from '../query-selection-snapshot';

it('finishes a snapshot before index work admitted after its first database statement', async () => {
  const db = new PGlite();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let background: Promise<void> | undefined;
  let selection: Promise<string | null> | undefined;
  try {
    await db.exec(`
      CREATE TABLE selection_snapshots (
        id UUID PRIMARY KEY DEFAULT uuidv7(), expires_at TIMESTAMPTZ
      );
      CREATE TABLE selection_snapshot_files (
        snapshot_id UUID REFERENCES selection_snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL, UNIQUE (snapshot_id, file_path)
      );
    `);
    const scheduled = createScheduledDbHandle(
      {
        query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
        transaction: <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) =>
          db.transaction(async (tx) =>
            fn({ query: <R>(sql: string, params?: unknown[]) => tx.query<R>(sql, params) })
          ),
      },
      createDatabaseWorkScheduler(),
      'foreground'
    );
    const handle: DbHandle = {
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await scheduled.query<T>(sql, params);
        if (background === undefined) {
          background = scheduled.transaction(async (tx) => {
            started.resolve();
            await release.promise;
            await tx.query('SELECT 1');
          });
        }
        return result;
      },
    };
    let selected: string | null = null;
    selection = createQuerySelectionSnapshot(handle, ['one.ts']).then((id) => {
      selected = id;
      return id;
    });
    await started.promise;
    // The unrelated work stays physically held. A multi-query snapshot queues
    // its next statement behind it and can exhaust its unchanged 30s budget.
    await vi.waitFor(() => expect(selected).toBeTypeOf('string'));
  } finally {
    release.resolve();
    try {
      await Promise.all([selection, background]);
    } finally {
      await db.close();
    }
  }
});

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
