import type { RootDescriptor } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { reconcileRoots } from '../roots/root-registry';

function fsaRoot(rootId: string, name: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path: name, platform: 'web' },
    kind: 'fsa',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

describe('reconcileRoots', () => {
  it('maps adapter roots onto an existing DB row by path without modifying it', async () => {
    const dbRows = [{ id: 'db-1', path: 'my-project' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
  });

  it('skips roots with persisted:false or permissionState unknown (no DB rows for session-only ids)', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: [] } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [
        { ...fsaRoot('a-ephemeral', 'x'), persisted: false },
        { ...fsaRoot('a-dead', 'y'), permissionState: 'unknown' },
      ],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.size).toBe(0);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
  });

  it('inserts a new roots row with the adapter RootId when no DB row matches', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: [] } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-2', 'fresh-folder')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-2')).toBe('adapter-2');
    const insertCall = query.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO roots')
    );
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(['adapter-2', 'fsa', 'fresh-folder', 'fresh-folder'])
    );
  });

  it('issues exactly one INSERT for two same-path roots in one call; second maps to the first id', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: [] } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-a', 'shared-folder'), fsaRoot('adapter-b', 'shared-folder')],
      platformKind: 'fsa',
      query,
    });

    const insertCalls = query.mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO roots')
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.[1]).toEqual(expect.arrayContaining(['adapter-a']));
    expect(result.dbRootIdByAdapterRootId.get('adapter-a')).toBe('adapter-a');
    expect(result.dbRootIdByAdapterRootId.get('adapter-b')).toBe('adapter-a');
  });

  it('converges on the existing row when a concurrent writer wins the path-unique race', async () => {
    // ON CONFLICT (id) does not cover idx_roots_path: a same-path row landing
    // between the SELECT and the INSERT throws. The loop must converge on the
    // winner's row and keep registering the remaining roots.
    let insertAttempted = false;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('INSERT')) {
        insertAttempted = true;
        throw new Error('duplicate key value violates unique constraint "idx_roots_path"');
      }
      if (sql.includes('WHERE path =')) {
        // The concurrent winner's row, visible on re-select.
        return { rows: [{ id: 'winner-id', path: 'my-project' }] };
      }
      return { rows: [] };
    });

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project'), fsaRoot('adapter-2', 'other-project')],
      platformKind: 'fsa',
      query,
    });

    expect(insertAttempted).toBe(true);
    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('winner-id');
    // The loop continued: the second root still registered (its own insert
    // also "converges" in this mock, proving no abort).
    expect(result.dbRootIdByAdapterRootId.has('adapter-2')).toBe(true);
  });

  it('rethrows non-path-race insert failures instead of swallowing them', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('INSERT')) {
        throw new Error('connection lost');
      }
      return { rows: [] };
    });

    await expect(
      reconcileRoots({
        adapterRoots: [fsaRoot('adapter-1', 'my-project')],
        platformKind: 'fsa',
        query,
      })
    ).rejects.toThrow('connection lost');
  });

  it('leaves unmatched legacy DB rows untouched', async () => {
    const dbRows = [{ id: 'db-orphan', path: 'gone-folder' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    await reconcileRoots({ adapterRoots: [], platformKind: 'fsa', query });

    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE roots'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
  });
});
