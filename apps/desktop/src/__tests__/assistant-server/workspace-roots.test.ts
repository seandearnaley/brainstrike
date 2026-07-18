import type { RuntimeData } from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
  orderWorkspaceRoots,
  resolveWorkspaceRoot,
  type WorkspaceRootsQueryable,
} from '../../assistant-server/workspace-roots';

function mockDb(rows: unknown[]): WorkspaceRootsQueryable {
  return { query: vi.fn(async () => ({ rows: rows as never[] })) };
}

const ROOT_A = { displayName: 'ProjectA', path: '/Users/me/ProjectA', rootId: 'root-a' };
const ROOT_B = { displayName: 'ProjectB', path: '/Users/me/ProjectB', rootId: 'root-b' };

function runtime(overrides: Partial<RuntimeData> = {}): RuntimeData {
  return { provider: 'openai', ...overrides } as RuntimeData;
}

describe('getWorkspaceRoots', () => {
  it('returns the explicit workspaceRoots list when present', () => {
    expect(getWorkspaceRoots(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }))).toEqual([
      ROOT_A,
      ROOT_B,
    ]);
  });

  it('synthesizes a single root from workspaceRootPath when workspaceRoots is absent', () => {
    const roots = getWorkspaceRoots(runtime({ workspaceRootPath: '/Users/me/Solo' }));
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ displayName: 'Solo', path: '/Users/me/Solo' });
    expect(roots[0]?.rootId.length).toBeGreaterThan(0);
  });

  it('drops roots without an absolute path', () => {
    const roots = getWorkspaceRoots(
      runtime({ workspaceRoots: [ROOT_A, { displayName: 'web', path: '', rootId: 'x' }] })
    );
    expect(roots).toEqual([ROOT_A]);
  });

  it('returns an empty list when neither workspaceRoots nor workspaceRootPath is set', () => {
    expect(getWorkspaceRoots(runtime())).toEqual([]);
  });
});

describe('resolveWorkspaceRoot', () => {
  it('throws a clear "no folder open" error when there are no roots', () => {
    expect(() => resolveWorkspaceRoot(runtime())).toThrow(/no folder is open/i);
  });

  it('returns the sole root when there is exactly one and no qualifier', () => {
    expect(resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A] }))).toEqual(ROOT_A);
  });

  it('errors and lists the open folders when ambiguous (multiple roots, no qualifier)', () => {
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }))).toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
  });

  it('resolves by rootId', () => {
    expect(resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }), 'root-b')).toEqual(
      ROOT_B
    );
  });

  it('resolves by display name (case-insensitive)', () => {
    expect(resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }), 'projecta')).toEqual(
      ROOT_A
    );
  });

  it('errors with the available folders for an unknown qualifier', () => {
    expect(() =>
      resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }), 'Nope')
    ).toThrow(/no folder "Nope".*ProjectA.*ProjectB/is);
  });

  it('errors and asks for the root id when two roots share a display name', () => {
    const dupA = { displayName: 'src', path: '/a/src', rootId: 'dup-1' };
    const dupB = { displayName: 'src', path: '/b/src', rootId: 'dup-2' };
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [dupA, dupB] }), 'src')).toThrow(
      /multiple folders.*named "src".*id/is
    );
  });
});

describe('loadWorkspaceRootsFromDatabase', () => {
  it('queries only live, path-backed roots and maps them', async () => {
    const db = mockDb([
      { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
      { displayName: 'ProjectB', id: 'root-b', path: '/Users/me/ProjectB' },
    ]);
    const roots = await loadWorkspaceRootsFromDatabase(db);
    expect(roots).toEqual([ROOT_A, ROOT_B]);
    const firstCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall?.[0]).toMatch(/FROM roots/i);
    expect(firstCall?.[0]).toMatch(/status = \$1/);
    expect(firstCall?.[0]).toMatch(/path IS NOT NULL/i);
    expect(firstCall?.[1]).toEqual(['live']);
  });

  it('drops rows with a null/empty path (e.g. web FSA roots)', async () => {
    const db = mockDb([
      { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
      { displayName: 'web-root', id: 'web', path: null },
    ]);
    expect(await loadWorkspaceRootsFromDatabase(db)).toEqual([ROOT_A]);
  });
});

describe('markRootDisconnectedByPath', () => {
  it("updates status to 'disconnected' keyed by path (never DELETEs), returning the match count", async () => {
    const db = mockDb([{ id: 'root-a' }]);
    const count = await markRootDisconnectedByPath(db, '/Users/me/ProjectA');
    expect(count).toBe(1);
    const firstCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall?.[0]).toMatch(/UPDATE roots/i);
    expect(firstCall?.[0]).toMatch(/status = 'disconnected'/);
    expect(firstCall?.[0]).toMatch(/WHERE path = \$1/i);
    // RETURNING lets the caller detect a 0-row (path-mismatch) disconnect, since
    // the DB host protocol surfaces only rows — never affectedRows.
    expect(firstCall?.[0]).toMatch(/RETURNING id/i);
    expect(firstCall?.[0]).not.toMatch(/DELETE/i);
    expect(firstCall?.[1]).toEqual(['/Users/me/ProjectA']);
  });

  it('returns 0 when no row matches the path (session-only root / path mismatch)', async () => {
    const db = mockDb([]);
    expect(await markRootDisconnectedByPath(db, '/Users/me/Ghost')).toBe(0);
  });

  it('propagates query failures (the disconnect IPC fails closed)', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(markRootDisconnectedByPath(db, '/Users/me/ProjectA')).rejects.toThrow('db down');
  });
});

describe('orderWorkspaceRoots (client-declared MAIN root reorder)', () => {
  const ROOT_C = { displayName: 'ProjectC', path: '/Users/me/ProjectC', rootId: 'root-c' };

  it('moves the root matching mainRootId to the FRONT, preserving the rest', () => {
    expect(orderWorkspaceRoots([ROOT_A, ROOT_B, ROOT_C], 'root-c', undefined)).toEqual([
      ROOT_C,
      ROOT_A,
      ROOT_B,
    ]);
  });

  it('falls back to a resolved-path match when the id does not match (legacy id divergence)', () => {
    expect(
      orderWorkspaceRoots([ROOT_A, ROOT_B], 'client-uuid-not-db-id', '/Users/me/ProjectB/')
    ).toEqual([ROOT_B, ROOT_A]);
  });

  it('keeps the created_at (input) order when neither id nor path matches', () => {
    expect(orderWorkspaceRoots([ROOT_A, ROOT_B], 'nope', '/Users/me/Elsewhere')).toEqual([
      ROOT_A,
      ROOT_B,
    ]);
  });

  it('keeps the input order when no main declaration is present', () => {
    expect(orderWorkspaceRoots([ROOT_A, ROOT_B], undefined, undefined)).toEqual([ROOT_A, ROOT_B]);
  });

  it('is a no-op when the declared main root is already first', () => {
    expect(orderWorkspaceRoots([ROOT_A, ROOT_B], 'root-a', undefined)).toEqual([ROOT_A, ROOT_B]);
  });
});

describe('enrichRuntimeDataWithWorkspaceRoots', () => {
  it('reorders DB roots so the client-declared main root is first', async () => {
    const db = mockDb([
      { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
      { displayName: 'ProjectB', id: 'root-b', path: '/Users/me/ProjectB' },
    ]);
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({ mainRootId: 'root-b', workspaceRootPath: '/Users/me/ProjectA' }),
      db
    );
    expect(enriched?.workspaceRoots).toEqual([ROOT_B, ROOT_A]);
  });

  it('keeps created_at order when the declared main root is not a live DB root', async () => {
    const db = mockDb([
      { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
      { displayName: 'ProjectB', id: 'root-b', path: '/Users/me/ProjectB' },
    ]);
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({ mainRootId: 'gone', mainRootPath: '/Users/me/Elsewhere' }),
      db
    );
    expect(enriched?.workspaceRoots).toEqual([ROOT_A, ROOT_B]);
  });

  it('injects DB roots when none are present on the runtime', async () => {
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({ workspaceRootPath: '/Users/me/ProjectA' }),
      mockDb([{ displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' }])
    );
    expect(enriched?.workspaceRoots).toEqual([ROOT_A]);
  });

  it('leaves client-provided workspaceRoots untouched', async () => {
    const db = mockDb([{ displayName: 'Other', id: 'other', path: '/x' }]);
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({ workspaceRoots: [ROOT_A] }),
      db
    );
    expect(enriched?.workspaceRoots).toEqual([ROOT_A]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('leaves the runtime unchanged when the DB has no roots (single-root fallback)', async () => {
    const input = runtime({ workspaceRootPath: '/Users/me/Solo' });
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(input, mockDb([]));
    expect(enriched?.workspaceRoots).toBeUndefined();
  });

  it('falls back (unchanged) when the roots query throws', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const input = runtime({ workspaceRootPath: '/Users/me/Solo' });
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(input, db);
    expect(enriched?.workspaceRoots).toBeUndefined();
  });
});
