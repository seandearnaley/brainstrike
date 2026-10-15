import type { RuntimeData } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
  markRootsDisconnectedExcept,
  orderWorkspaceRoots,
  resolveOptionalWorkspaceRoot,
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

  it('rejects a renderer-provided path when the authoritative inventory is absent', () => {
    expect(() => getWorkspaceRoots(runtime({ workspaceRootPath: '/Users/me/Untrusted' }))).toThrow(
      /authoritative workspace root inventory is unavailable/i
    );
  });

  it('rejects an explicit empty root list combined with a legacy path', () => {
    expect(() =>
      getWorkspaceRoots(runtime({ workspaceRootPath: '/Users/me/Solo', workspaceRoots: [] }))
    ).toThrow(/root metadata is inconsistent/i);
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
    expect(() => resolveWorkspaceRoot(runtime())).toThrow(ToolInputError);
    expect(() => resolveWorkspaceRoot(runtime())).toThrow(/no folder is open/i);
  });

  it('redacts a path-backed legacy bound id from a missing-root error', () => {
    const legacyRootId = '/Users/me/SecretProject';
    expect(() =>
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: legacyRootId,
          workspaceRoots: [ROOT_A, ROOT_B],
        })
      )
    ).toThrow(/path-backed id redacted/i);
    expect(() =>
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: legacyRootId,
          workspaceRoots: [ROOT_A, ROOT_B],
        })
      )
    ).not.toThrow(legacyRootId);
  });

  it('returns the sole root when there is exactly one and no qualifier', () => {
    expect(resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A] }))).toEqual(ROOT_A);
  });

  it('errors and lists the open folders when ambiguous (multiple roots, no qualifier)', () => {
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }))).toThrow(
      ToolInputError
    );
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }))).toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
    expect(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [ROOT_A, ROOT_B] }))).toThrow(
      /ProjectA \(id root-a\).*ProjectB \(id root-b\)/is
    );
  });

  it('binds an omitted qualifier to the request-start thread root', () => {
    expect(
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: 'root-b',
          workspaceRoots: [ROOT_A, ROOT_B],
        })
      )
    ).toEqual(ROOT_B);
  });

  it('requires an authoritative root inventory before resolving a durable binding', () => {
    expect(() =>
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: 'root-b',
          workspaceRootPath: '/Users/me/ProjectB',
        })
      )
    ).toThrow(/authoritative workspace root inventory is unavailable/i);
  });

  it('preserves an explicit mounted-root override outside the bound thread root', () => {
    expect(
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: 'root-a',
          workspaceRoots: [ROOT_A, ROOT_B],
        }),
        'root-b'
      )
    ).toEqual(ROOT_B);
  });

  it('rejects an explicitly blank qualifier instead of treating it as an omission', () => {
    const boundRuntime = runtime({
      boundWorkspaceRootId: 'root-a',
      workspaceRoots: [ROOT_A, ROOT_B],
    });

    expect(() => resolveWorkspaceRoot(boundRuntime, '   ')).toThrow(
      /"root" argument must not be blank/i
    );
    expect(() => resolveOptionalWorkspaceRoot(boundRuntime, '')).toThrow(
      /"root" argument must not be blank/i
    );
  });

  it('fails visibly when the bound thread root is no longer live', () => {
    expect(() =>
      resolveWorkspaceRoot(
        runtime({
          boundWorkspaceRootId: 'root-gone',
          workspaceRoots: [ROOT_A, ROOT_B],
        })
      )
    ).toThrow(/bound workspace root.*root-gone.*no longer open/i);
  });

  it('formats an oversized first root without a leading overflow delimiter', () => {
    const oversized = {
      displayName: 'Project',
      path: '/Users/me/Project',
      rootId: 'x'.repeat(801),
    };
    const getErrorMessage = () => {
      try {
        resolveWorkspaceRoot(runtime({ workspaceRoots: [oversized, ROOT_B] }), 'Nope');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('Expected root resolution to fail');
    };

    const message = getErrorMessage();
    expect(message).toContain('Open folders: 2 more not shown.');
    expect(message).not.toContain('Open folders: ;');
  });

  it('keeps the complete root inventory when it fits without overflow guidance', () => {
    const longRootId = 'x'.repeat(735);
    const longRoot = {
      displayName: 'Project',
      path: '/Users/me/Project',
      rootId: longRootId,
    };

    expect.assertions(2);
    try {
      resolveWorkspaceRoot(runtime({ workspaceRoots: [longRoot, ROOT_B] }), 'Nope');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const descriptor = message.slice(
        message.indexOf('Open folders: ') + 'Open folders: '.length,
        -1
      );
      expect(descriptor.length).toBeLessThanOrEqual(800);
      expect(descriptor).toContain(longRootId);
    }
  });

  it('reserves room for overflow guidance when the complete root inventory does not fit', () => {
    const longRootId = 'x'.repeat(735);
    const longRoot = {
      displayName: 'Project',
      path: '/Users/me/Project',
      rootId: longRootId,
    };

    expect.assertions(2);
    try {
      resolveWorkspaceRoot(
        runtime({ workspaceRoots: [longRoot, ROOT_A, ROOT_B, ROOT_A, ROOT_B] }),
        'Nope'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const descriptor = message.slice(
        message.indexOf('Open folders: ') + 'Open folders: '.length,
        -1
      );
      expect(descriptor.length).toBeLessThanOrEqual(800);
      expect(descriptor).not.toContain(longRootId.slice(0, 100));
    }
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
    ).toThrow(/no folder "Nope".*ProjectA \(id root-a\).*ProjectB \(id root-b\)/is);
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
  it("updates status to 'disconnected' keyed by path (never DELETEs), returning durable ids", async () => {
    const db = mockDb([{ id: 'root-a' }]);
    const rootIds = await markRootDisconnectedByPath(db, '/Users/me/ProjectA');
    expect(rootIds).toEqual(['root-a']);
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

  it('returns no ids when no row matches the path (session-only root / path mismatch)', async () => {
    const db = mockDb([]);
    expect(await markRootDisconnectedByPath(db, '/Users/me/Ghost')).toEqual([]);
  });

  it('propagates query failures (the disconnect IPC fails closed)', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(markRootDisconnectedByPath(db, '/Users/me/ProjectA')).rejects.toThrow('db down');
  });

  it('revokes an in-flight runtime snapshot as soon as its root disconnects', async () => {
    const root = {
      displayName: 'Revoked',
      path: '/Users/me/Revoked',
      rootId: 'root-revoked-during-run',
    };
    const runtimeSnapshot = runtime({
      boundWorkspaceRootId: root.rootId,
      workspaceRoots: [root, ROOT_B],
    });

    expect(resolveWorkspaceRoot(runtimeSnapshot)).toEqual(root);
    await markRootDisconnectedByPath(mockDb([{ id: root.rootId }]), root.path);
    expect(() => resolveWorkspaceRoot(runtimeSnapshot)).toThrow(/disconnected during this run/i);

    // A later authoritative live-root load represents reconnect/reconciliation
    // and makes the same durable id usable again.
    await loadWorkspaceRootsFromDatabase(
      mockDb([{ displayName: root.displayName, id: root.rootId, path: root.path }])
    );
    expect(resolveWorkspaceRoot(runtimeSnapshot)).toEqual(root);
  });
});

describe('markRootsDisconnectedExcept (boot convergence)', () => {
  it('demotes live path-backed rows that are NOT mounted, keyed by the mounted path set', async () => {
    const db = mockDb([{ id: 'stale-a', path: '/Users/me/Downloads' }]);
    const demoted = await markRootsDisconnectedExcept(db, ['/Users/me/ProjectA']);

    expect(demoted).toEqual([{ id: 'stale-a', path: '/Users/me/Downloads' }]);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(sql).toMatch(/UPDATE roots/i);
    expect(sql).toMatch(/status = 'disconnected'/);
    expect(sql).toMatch(/WHERE status = 'live'/i);
    // Only rows whose mount state is DETERMINABLE from a path may be demoted —
    // a null/empty-path (FSA) row is not comparable, so it is left untouched.
    expect(sql).toMatch(/path IS NOT NULL/i);
    expect(sql).toMatch(/RETURNING id/i);
    expect(sql).not.toMatch(/DELETE/i);
    expect(params).toEqual([['/Users/me/ProjectA']]);
  });

  it('demotes every live path-backed row when nothing is mounted (empty rootsList)', async () => {
    const db = mockDb([
      { id: 'stale-a', path: '/Users/me/Downloads' },
      { id: 'stale-b', path: '/Users/me/Old' },
    ]);
    const demoted = await markRootsDisconnectedExcept(db, []);

    expect(demoted).toHaveLength(2);
    const params = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(params).toEqual([[]]);
  });

  it('returns no ids when every live row is mounted (steady state)', async () => {
    const db = mockDb([]);
    expect(await markRootsDisconnectedExcept(db, ['/Users/me/ProjectA'])).toEqual([]);
  });

  it('propagates query failures so the caller decides how to degrade', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(markRootsDisconnectedExcept(db, [])).rejects.toThrow('db down');
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
  it('orders the durable thread binding ahead of a later global Main root', async () => {
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(
      runtime({
        boundWorkspaceRootId: 'root-b',
        mainRootId: 'root-a',
        workspaceRootPath: '/Users/me/ProjectA',
      }),
      mockDb([
        { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
        { displayName: 'ProjectB', id: 'root-b', path: '/Users/me/ProjectB' },
      ])
    );

    expect(enriched?.workspaceRoots).toEqual([ROOT_B, ROOT_A]);
  });

  it('rejects a durable thread binding that is absent from the live DB roots', async () => {
    await expect(
      enrichRuntimeDataWithWorkspaceRoots(
        runtime({
          boundWorkspaceRootId: 'root-gone',
          mainRootId: 'root-a',
          workspaceRootPath: '/Users/me/ProjectA',
        }),
        mockDb([
          { displayName: 'ProjectA', id: 'root-a', path: '/Users/me/ProjectA' },
          { displayName: 'ProjectB', id: 'root-b', path: '/Users/me/ProjectB' },
        ])
      )
    ).rejects.toThrow(/bound workspace root.*root-gone.*no longer open/i);
  });

  it('rejects a durable thread binding when the DB has no live roots', async () => {
    await expect(
      enrichRuntimeDataWithWorkspaceRoots(
        runtime({
          boundWorkspaceRootId: 'root-gone',
          workspaceRootPath: '/Users/me/ProjectA',
        }),
        mockDb([])
      )
    ).rejects.toThrow(/bound workspace root.*root-gone.*no longer open/i);
  });

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

  it('records an authoritative empty inventory when the DB has no live roots', async () => {
    const input = runtime({ workspaceRootPath: '/Users/me/Solo' });
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(input, mockDb([]));
    expect(enriched?.workspaceRoots).toEqual([]);
    expect(enriched?.workspaceRootPath).toBeUndefined();
    expect(getWorkspaceRoots(enriched)).toEqual([]);
  });

  it('records an authoritative empty root list when the DB has no roots or legacy path', async () => {
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(runtime(), mockDb([]));
    expect(enriched?.workspaceRoots).toEqual([]);
  });

  it('leaves the authoritative inventory absent when the roots query throws', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const input = runtime({ workspaceRootPath: '/Users/me/Solo' });
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(input, db);
    expect(enriched?.workspaceRoots).toBeUndefined();
    expect(() => getWorkspaceRoots(enriched)).toThrow(
      /authoritative workspace root inventory is unavailable/i
    );
  });

  it('does not fabricate an empty root list when the roots query throws', async () => {
    const db: WorkspaceRootsQueryable = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const enriched = await enrichRuntimeDataWithWorkspaceRoots(runtime(), db);
    expect(enriched?.workspaceRoots).toBeUndefined();
  });
});
