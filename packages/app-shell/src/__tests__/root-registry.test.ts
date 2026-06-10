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
