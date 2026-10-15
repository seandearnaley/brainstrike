/**
 * Disconnect lifecycle over a REAL migrated PGlite:
 * add (reconcileRoots insert) → the assistant loader serves the root →
 * fs:removeRoot's markRootDisconnectedByPath → the loader excludes it →
 * re-add of the same path under a NEW adapter id (remount-by-path) →
 * reconcileRoots maps to the SAME roots.id and restores status='live' →
 * the loader serves it again. Proves disconnect ≠ delete end-to-end: the row
 * (and therefore every file_records.root_id referent) survives the cycle, so
 * a remount resumes without re-indexing.
 */

import { type RootsQueryFn, reconcileRoots } from '@brainstrike/app-shell/roots/root-registry';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { RootDescriptor } from '@brainstrike/types';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
  markRootsDisconnectedExcept,
  type WorkspaceRootsQueryable,
} from '../../assistant-server/workspace-roots';

const ROOT_PATH = '/workspace/project-a';

let db: PGlite;

const registryQuery: RootsQueryFn = async (sql, params) =>
  (await db.query(sql, params)) as { rows: unknown[] };

const rootsDb: WorkspaceRootsQueryable = {
  query: async (sql, params) => (await db.query(sql, params ? [...params] : undefined)) as never,
};

function pathRoot(rootId: string, rootPath: string): RootDescriptor {
  return {
    displayName: 'project-a',
    handle: { kind: 'directory', name: 'project-a', path: rootPath, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

beforeEach(async () => {
  db = await createMigratedTestDb();
});

afterEach(async () => {
  await db.close();
});

describe('workspace roots disconnect lifecycle', () => {
  it('serves a root only while live: add → disconnect → remount keeps the same id', async () => {
    // Add: a fresh insert registers under the adapter's rootId.
    const added = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-1', ROOT_PATH)],
      platformKind: 'path',
      query: registryQuery,
    });
    expect(added.dbRootIdByAdapterRootId.get('adapter-1')).toBe('adapter-1');

    let roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots.map((root) => root.rootId)).toEqual(['adapter-1']);

    // Disconnect (the fs:removeRoot seam): the row is KEPT, only status moves.
    // A non-existent path matches 0 rows; the real one matches exactly 1.
    expect(await markRootDisconnectedByPath(rootsDb, '/workspace/ghost')).toEqual([]);
    expect(await markRootDisconnectedByPath(rootsDb, ROOT_PATH)).toEqual(['adapter-1']);
    roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots).toEqual([]);
    const disconnected = await db.query('SELECT status FROM roots WHERE id = $1', ['adapter-1']);
    expect(disconnected.rows).toEqual([{ status: 'disconnected' }]);

    // Remount the same path: fs:addRoot mints a NEW adapter uuid, but
    // reconcileRoots path-matches the kept row — same DB identity, no
    // re-index — and restores status='live'.
    const remounted = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-2', ROOT_PATH)],
      platformKind: 'path',
      query: registryQuery,
    });
    expect(remounted.dbRootIdByAdapterRootId.get('adapter-2')).toBe('adapter-1');

    roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots.map((root) => root.rootId)).toEqual(['adapter-1']);
    const restored = (await db.query('SELECT status, last_verified_at FROM roots WHERE id = $1', [
      'adapter-1',
    ])) as { rows: Array<{ last_verified_at: unknown; status: string }> };
    expect(restored.rows[0]?.status).toBe('live');
    expect(restored.rows[0]?.last_verified_at).not.toBeNull();
  });

  it('disconnecting one root leaves the others serving', async () => {
    await reconcileRoots({
      adapterRoots: [
        pathRoot('adapter-a', '/workspace/project-a'),
        pathRoot('adapter-b', '/workspace/project-b'),
      ],
      platformKind: 'path',
      query: registryQuery,
    });

    await markRootDisconnectedByPath(rootsDb, '/workspace/project-a');

    const roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots.map((root) => root.rootId)).toEqual(['adapter-b']);
  });
});

/**
 * The fs:restoreRoots convergence seam over the same REAL PGlite. Exercises the
 * SQL itself (`NOT (path = ANY($1::text[]))`), which the mocked unit tests
 * cannot: the empty-array case in particular must demote EVERYTHING rather than
 * silently matching nothing.
 */
describe('boot convergence (markRootsDisconnectedExcept)', () => {
  beforeEach(async () => {
    await reconcileRoots({
      adapterRoots: [
        pathRoot('adapter-a', '/workspace/project-a'),
        pathRoot('adapter-b', '/workspace/project-b'),
        pathRoot('adapter-c', '/workspace/project-c'),
      ],
      platformKind: 'path',
      query: registryQuery,
    });
  });

  it('demotes exactly the live roots missing from the mounted set', async () => {
    const demoted = await markRootsDisconnectedExcept(rootsDb, ['/workspace/project-b']);

    expect(demoted.map((row) => row.id).sort()).toEqual(['adapter-a', 'adapter-c']);
    const roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots.map((root) => root.rootId)).toEqual(['adapter-b']);
  });

  it('demotes every live root when nothing is mounted', async () => {
    const demoted = await markRootsDisconnectedExcept(rootsDb, []);

    expect(demoted).toHaveLength(3);
    expect(await loadWorkspaceRootsFromDatabase(rootsDb)).toEqual([]);
  });

  it('is a no-op when every live root is mounted, and is idempotent', async () => {
    const mounted = ['/workspace/project-a', '/workspace/project-b', '/workspace/project-c'];

    expect(await markRootsDisconnectedExcept(rootsDb, mounted)).toEqual([]);
    // Second pass has nothing left to demote — convergence, not a toggle.
    expect(await markRootsDisconnectedExcept(rootsDb, mounted)).toEqual([]);
    const roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots).toHaveLength(3);
  });

  it('never DELETEs: a demoted root remounts by path with the same id', async () => {
    await markRootsDisconnectedExcept(rootsDb, []);

    const remounted = await reconcileRoots({
      adapterRoots: [pathRoot('adapter-new', '/workspace/project-a')],
      platformKind: 'path',
      query: registryQuery,
    });

    expect(remounted.dbRootIdByAdapterRootId.get('adapter-new')).toBe('adapter-a');
    const roots = await loadWorkspaceRootsFromDatabase(rootsDb);
    expect(roots.map((root) => root.rootId)).toEqual(['adapter-a']);
  });
});
