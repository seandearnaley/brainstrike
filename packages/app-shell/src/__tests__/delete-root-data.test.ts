import type { DbHandle } from '@brainstrike/db';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { describe, expect, it, vi } from 'vitest';
import { deleteRootDataFromDb, resolveRootDataDeletionSelector } from '../roots/delete-root-data';

function makeDb(queryImpl: (sql: string, params?: unknown[]) => unknown): {
  db: DbHandle;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params));
  return { db: { query } as unknown as DbHandle, query };
}

describe('deleteRootDataFromDb', () => {
  it('matches the row by id OR path (so a UUID rootId deletes its row)', async () => {
    const { db, query } = makeDb(() => ({
      rows: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }],
    }));

    await deleteRootDataFromDb(
      { db, runtimeEngine: 'pglite' },
      'aaaaaaaa-0000-0000-0000-000000000001'
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM roots');
    expect(sql).toContain('id = $1 OR path = $1');
    expect(sql).toContain('RETURNING id');
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

  it('deletes a path-bridged Turso row by DB id when the adapter id differs', async () => {
    const { db, query } = makeDb((sql) => {
      if (sql.startsWith('SELECT id, path FROM roots')) {
        return { rows: [{ id: 'db-root-id', path: '/Users/me/project' }] };
      }
      return { rows: [{ id: 'db-root-id' }] };
    });

    await deleteRootDataFromDb(
      { db, runtimeEngine: 'turso' },
      { rootId: 'adapter-root-id', rootPath: '/Users/me/project' }
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([
      'SELECT id, path FROM roots WHERE id = ? OR path = ?',
      ['adapter-root-id', '/Users/me/project'],
    ]);
    expect(query.mock.calls[1]).toEqual([
      'DELETE FROM roots WHERE id = ? RETURNING id',
      ['db-root-id'],
    ]);
  });

  it('throws before deleting when a path fallback would match multiple roots', async () => {
    const { db, query } = makeDb(() => ({
      rows: [
        { id: 'db-root-a', path: 'project' },
        { id: 'db-root-b', path: 'project' },
      ],
    }));

    await expect(
      deleteRootDataFromDb(
        { db, runtimeEngine: 'turso' },
        { rootId: 'adapter-a', rootPath: 'project' }
      )
    ).rejects.toThrow(/ambiguous root path/);

    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT id, path FROM roots WHERE id = ? OR path = ?',
      ['adapter-a', 'project']
    );
  });

  it('deletes a legacy root passed by PATH (the silent-no-op regression)', async () => {
    // The sidebar falls back to handle.path when rootIdByPath has no entry.
    // roots.id is always a uuidv7, so `id = '<path>'` alone matched zero rows
    // and silently "succeeded" while the UUID-keyed row + cascade survived.
    const { db } = makeDb((_sql, params) =>
      (params as string[])[0] === '/Users/me/project' ? { rows: [{ id: 'root-id' }] } : { rows: [] }
    );

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, '/Users/me/project')
    ).resolves.toBeUndefined();
  });

  it('THROWS when the delete positively affects zero rows (no silent success)', async () => {
    const { db } = makeDb(() => ({ rows: [] }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, 'no-such-root')
    ).rejects.toThrow(/matched no rows/);
  });

  it('THROWS when the PGlite bridge strips affected-row counts and returns no rows', async () => {
    const { db } = makeDb(() => ({ rows: [] }));

    await expect(
      deleteRootDataFromDb({ db, runtimeEngine: 'pglite' }, 'some-root')
    ).rejects.toThrow(/matched no rows/);
  });

  it('resolves a unique mounted adapter root to its handle path for DB deletion', () => {
    const handle = {
      name: 'project',
      path: '/Users/me/project',
      rootId: 'adapter-root-id',
    } as DirectoryHandle;

    expect(resolveRootDataDeletionSelector('adapter-root-id', [handle], new Map())).toEqual({
      rootId: 'adapter-root-id',
      rootPath: '/Users/me/project',
    });
  });

  it('does not attach a path fallback for same-named active FSA roots', () => {
    const handles = [
      { name: 'project', path: 'project', rootId: 'adapter-a' },
      { name: 'project', path: 'project', rootId: 'adapter-b' },
    ] as DirectoryHandle[];

    expect(resolveRootDataDeletionSelector('adapter-a', handles, new Map())).toEqual({
      rootId: 'adapter-a',
    });
  });
});
