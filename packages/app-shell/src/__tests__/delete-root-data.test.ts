// @vitest-environment node
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import { deleteRootData, deleteRootDataFromDb } from '../delete-root-data';

function makeDb(queryImpl: (sql: string, params?: unknown[]) => unknown): {
  db: DbHandle;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params));
  return { db: { query } as unknown as DbHandle, query };
}

describe('deleteRootDataFromDb', () => {
  it('matches the row by id OR path (so a UUID rootId deletes its row)', async () => {
    const { db, query } = makeDb(() => ({ affectedRows: 1, rows: [] }));

    await deleteRootDataFromDb(db, 'aaaaaaaa-0000-0000-0000-000000000001');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM roots');
    expect(sql).toContain('id = $1 OR path = $1');
    expect(params).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('deletes a legacy root passed by PATH (the silent-no-op regression)', async () => {
    // The sidebar falls back to handle.path when rootIdByPath has no entry.
    // roots.id is always a uuidv7, so `id = '<path>'` alone matched zero rows
    // and silently "succeeded" while the UUID-keyed row + cascade survived.
    const { db } = makeDb((_sql, params) =>
      (params as string[])[0] === '/Users/me/project' ? { affectedRows: 1, rows: [] } : { rows: [] }
    );

    await expect(deleteRootDataFromDb(db, '/Users/me/project')).resolves.toBeUndefined();
  });

  it('THROWS when the delete positively affects zero rows (no silent success)', async () => {
    const { db } = makeDb(() => ({ affectedRows: 0, rows: [] }));

    await expect(deleteRootDataFromDb(db, 'no-such-root')).rejects.toThrow(/matched no rows/);
  });

  it('reads node-pg-style rowCount when affectedRows is absent', async () => {
    const { db } = makeDb(() => ({ rowCount: 0, rows: [] }));

    await expect(deleteRootDataFromDb(db, 'no-such-root')).rejects.toThrow(/matched no rows/);
  });

  it('does NOT throw when the driver reports no count at all (cannot assert)', async () => {
    // A bridge that strips both affectedRows and rowCount: we must not false-
    // abort a delete we cannot measure. Old behavior preserved for that case.
    const { db } = makeDb(() => ({ rows: [] }));

    await expect(deleteRootDataFromDb(db, 'some-root')).resolves.toBeUndefined();
  });
});

describe('platform root deletion routing', () => {
  it('awaits the injected desktop capability without touching renderer PG', async () => {
    const { db, query } = makeDb(() => ({ affectedRows: 1, rows: [] }));
    const held = Promise.withResolvers<void>();
    const capability = vi.fn(() => held.promise);
    const deletion = deleteRootData(db, 'durable-root', capability);
    expect(capability).toHaveBeenCalledWith('durable-root');
    expect(query).not.toHaveBeenCalled();
    held.resolve();
    await deletion;
  });
  it('propagates desktop cleanup failure without PG fallback', async () => {
    const { db, query } = makeDb(() => ({ affectedRows: 1, rows: [] }));
    await expect(
      deleteRootData(db, 'root', async () => {
        throw new Error('Physical cleanup failed');
      })
    ).rejects.toThrow('Physical cleanup failed');
    expect(query).not.toHaveBeenCalled();
  });
  it('retains web PG deletion when no platform capability is supplied', async () => {
    const { db, query } = makeDb(() => ({ affectedRows: 1, rows: [] }));
    await deleteRootData(db, '/web/path');
    expect(query).toHaveBeenCalledOnce();
    await expect(deleteRootData(null, 'root')).rejects.toThrow('database is not ready');
  });
});
