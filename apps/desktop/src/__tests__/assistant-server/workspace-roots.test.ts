import type { RuntimeData } from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
  loadWorkspaceRootsFromDatabase,
  resolveWorkspaceRoot,
  type WorkspaceRootsQueryable,
} from '../../assistant-server/workspace-roots';

function mockDb(rows: unknown[]): WorkspaceRootsQueryable {
  return { query: vi.fn(async () => ({ rows: rows as never[] })) };
}

const ROOT_A = { rootId: 'root-a', displayName: 'ProjectA', path: '/Users/me/ProjectA' };
const ROOT_B = { rootId: 'root-b', displayName: 'ProjectB', path: '/Users/me/ProjectB' };

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
      runtime({ workspaceRoots: [ROOT_A, { rootId: 'x', displayName: 'web', path: '' }] })
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
    const dupA = { rootId: 'dup-1', displayName: 'src', path: '/a/src' };
    const dupB = { rootId: 'dup-2', displayName: 'src', path: '/b/src' };
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [dupA, dupB] }), 'src')).toThrow(
      /multiple folders.*named "src".*id/is
    );
  });
});

describe('loadWorkspaceRootsFromDatabase', () => {
  it('queries only live, path-backed roots and maps them', async () => {
    const db = mockDb([
      { id: 'root-a', displayName: 'ProjectA', path: '/Users/me/ProjectA' },
      { id: 'root-b', displayName: 'ProjectB', path: '/Users/me/ProjectB' },
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
      { id: 'root-a', displayName: 'ProjectA', path: '/Users/me/ProjectA' },
      { id: 'web', displayName: 'web-root', path: null },
    ]);
    expect(await loadWorkspaceRootsFromDatabase(db)).toEqual([ROOT_A]);
  });
});

describe('enrichRuntimeDataWithWorkspaceRoots', () => {
  it('injects DB roots when none are present on the runtime', async () => {
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({ workspaceRootPath: '/Users/me/ProjectA' }),
      mockDb([{ id: 'root-a', displayName: 'ProjectA', path: '/Users/me/ProjectA' }])
    );
    expect(enriched?.workspaceRoots).toEqual([ROOT_A]);
  });

  it('leaves client-provided workspaceRoots untouched', async () => {
    const db = mockDb([{ id: 'other', displayName: 'Other', path: '/x' }]);
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
