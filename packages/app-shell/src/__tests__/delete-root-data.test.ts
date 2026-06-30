import type { DbHandle } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { deleteRootDataFromDb } from '../roots/delete-root-data';

function makeDb(queryImpl: (sql: string, params?: unknown[]) => unknown): {
  db: DbHandle;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params));
  return { db: { query } as unknown as DbHandle, query };
}

describe('deleteRootDataFromDb', () => {
  it('matches the row by id OR path (so a UUID rootId deletes its row)', async () => {
    const { db, query } = makeDb(() => ({ rows: [], affectedRows: 1 }));

    await deleteRootDataFromDb(
      { db, runtimeEngine: 'pglite' },
      'aaaaaaaa-0000-0000-0000-000000000001'
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM roots');
    expect(sql).toContain('id = $1 OR path = $1');
    expect(params).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('uses SQLite placeholders for Turso root deletion', async () => {
    const { db, query } = makeDb(() => ({ rows: [{ id: 'root-id' }] }));

    await deleteRootDataFromDb({ db, runtimeEngine: 'turso' }, 'root-id');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM roots');
    expect(sql).toContain('id = ? OR path = ?');
    expect(sql).toContain('RETURNING id');
    expect(sql).not.toContain('$1');
    expect(params).toEqual(['root-id', 'root-id']);
  });

  it('throws when Turso root deletion returns no rows', async () => {
    const { db } = makeDb(() => ({ rows: [] }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'turso' }, 'missing-root')
    ).rejects.toThrow(/matched no rows/);
  });

  it('throws when Turso root deletion does not return row data', async () => {
    const { db } = makeDb(() => ({}));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'turso' }, 'untrusted-root')
    ).rejects.toThrow(/did not return deleted rows/);
  });

  it('deletes a legacy root passed by PATH (the silent-no-op regression)', async () => {
    // The sidebar falls back to handle.path when rootIdByPath has no entry.
    // roots.id is always a uuidv7, so `id = '<path>'` alone matched zero rows
    // and silently "succeeded" while the UUID-keyed row + cascade survived.
    const { db } = makeDb((_sql, params) =>
      (params as string[])[0] === '/Users/me/project' ? { rows: [], affectedRows: 1 } : { rows: [] }
    );

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, '/Users/me/project')
    ).resolves.toBeUndefined();
  });

  it('THROWS when the delete positively affects zero rows (no silent success)', async () => {
    const { db } = makeDb(() => ({ rows: [], affectedRows: 0 }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, 'no-such-root')
    ).rejects.toThrow(/matched no rows/);
  });

  it('reads node-pg-style rowCount when affectedRows is absent', async () => {
    const { db } = makeDb(() => ({ rows: [], rowCount: 0 }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, 'no-such-root')
    ).rejects.toThrow(/matched no rows/);
  });

  it('does NOT throw when the driver reports no count at all (cannot assert)', async () => {
    // A bridge that strips both affectedRows and rowCount: we must not false-
    // abort a delete we cannot measure. Old behavior preserved for that case.
    const { db } = makeDb(() => ({ rows: [] }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, 'some-root')
    ).resolves.toBeUndefined();
  });
});
