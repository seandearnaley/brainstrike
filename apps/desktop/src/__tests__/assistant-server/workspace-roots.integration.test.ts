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
import { migrate, wasmLoader } from '@brainstrike/db';
import type { RootDescriptor } from '@brainstrike/types';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
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
  db = await wasmLoader.createPGlite('memory://workspace-roots-lifecycle');
  await migrate(db);
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
    expect(await markRootDisconnectedByPath(rootsDb, '/workspace/ghost')).toBe(0);
    expect(await markRootDisconnectedByPath(rootsDb, ROOT_PATH)).toBe(1);
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
    const restored = await db.query<{ last_verified_at: unknown; status: string }>(
      'SELECT status, last_verified_at FROM roots WHERE id = $1',
      ['adapter-1']
    );
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
