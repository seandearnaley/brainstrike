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

function pathRoot(rootId: string, name: string, path: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

describe('reconcileRoots', () => {
  it('maps desktop path roots onto an existing live DB row by path without modifying it', async () => {
    const dbRows = [{ id: 'db-1', path: '/workspace/my-project', status: 'live' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-1', 'my-project', '/workspace/my-project')],
      platformKind: 'path',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
  });

  it("restores status='live' on a matched disconnected row (remount-by-path)", async () => {
    const dbRows = [{ id: 'db-1', path: '/workspace/my-project', status: 'disconnected' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-1', 'my-project', '/workspace/my-project')],
      platformKind: 'path',
      query,
    });

    // Same row id — file_records.root_id keeps pointing at the kept rows, so
    // the remount resumes without re-indexing.
    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
    const update = query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE roots'));
    expect(update?.[0]).toMatch(/status = 'live'/);
    expect(update?.[0]).toMatch(/last_verified_at = NOW\(\)/);
    expect(update?.[1]).toEqual(['db-1']);
  });

  it.each([
    'needs-regrant',
    'snapshot-stale',
  ])('does NOT resurrect a matched %s row to live (only disconnected is reversed)', async (status) => {
    const dbRows = [{ id: 'db-1', path: '/workspace/my-project', status }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-1', 'my-project', '/workspace/my-project')],
      platformKind: 'path',
      query,
    });

    // Still mapped (registration succeeds), but the stale/ungranted status is
    // left intact — a bare path remount must not skip its re-verification.
    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE roots'))).toBe(false);
  });

  it('keeps the mapping when the live-status flip fails (logged, not fatal)', async () => {
    const dbRows = [{ id: 'db-1', path: '/workspace/my-project', status: 'disconnected' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('UPDATE roots')) {
        throw new Error('update failed');
      }
      return sql.includes('SELECT') ? { rows: dbRows } : { rows: [] };
    });

    // The mapping is the load-bearing output (file_records.root_id stamping);
    // a failed flip degrades visibly (root stays non-live for the assistant
    // server) and retries next reconcile.
    const result = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-1', 'my-project', '/workspace/my-project')],
      platformKind: 'path',
      query,
    });
    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
  });

  it('does not path-match FSA roots because path is only the directory display name', async () => {
    const dbRows = [{ id: 'db-1', kind: 'fsa', path: 'my-project' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('adapter-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(true);
  });

  it('maps a unique FSA root onto its legacy DB row without modifying it', async () => {
    const dbRows = [{ id: 'legacy-db-1', kind: 'legacy', path: 'my-project' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('legacy-db-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE roots'))).toBe(false);
  });

  it('keeps a promoted unique FSA bridge idempotent across reconciles', async () => {
    const dbRows = [{ id: 'legacy-db-1', kind: 'legacy', path: 'my-project' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const first = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });
    const second = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });

    expect(first.dbRootIdByAdapterRootId.get('adapter-1')).toBe('legacy-db-1');
    expect(second.dbRootIdByAdapterRootId.get('adapter-1')).toBe('legacy-db-1');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE roots'))).toBe(false);
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

  it('registers two same-name FSA roots independently', async () => {
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
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]?.[1]).toEqual(expect.arrayContaining(['adapter-a']));
    expect(insertCalls[1]?.[1]).toEqual(expect.arrayContaining(['adapter-b']));
    expect(result.dbRootIdByAdapterRootId.get('adapter-a')).toBe('adapter-a');
    expect(result.dbRootIdByAdapterRootId.get('adapter-b')).toBe('adapter-b');
  });

  it('does not map same-name FSA roots onto a legacy row because the bridge is ambiguous', async () => {
    const dbRows = [{ id: 'legacy-db-1', kind: 'legacy', path: 'shared-folder' }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-a', 'shared-folder'), fsaRoot('adapter-b', 'shared-folder')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-a')).toBe('adapter-a');
    expect(result.dbRootIdByAdapterRootId.get('adapter-b')).toBe('adapter-b');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE roots'))).toBe(false);
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
      adapterRoots: [
        pathRoot('adapter-1', 'my-project', '/workspace/my-project'),
        pathRoot('adapter-2', 'other-project', '/workspace/other-project'),
      ],
      platformKind: 'path',
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
