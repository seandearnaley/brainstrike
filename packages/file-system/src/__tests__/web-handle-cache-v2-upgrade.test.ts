// fake-indexeddb/auto sets up all IDB globals (IDBRequest, IDBFactory, etc.)
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebHandleCache } from '../adapters/web-handle-cache';

const DB_NAME = 'brainstrike-file-handles';

/**
 * fake-indexeddb uses the structured-clone algorithm, which cannot clone
 * function-valued properties.  We store only the serialisable fields that
 * StoredRootHandle needs (kind, name) so the put() calls succeed.
 * The real app stores live FSA handles; in tests we exercise the *record
 * shape and key semantics*, not handle invocability.
 */
function makeDirectoryHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
  } as unknown as FileSystemDirectoryHandle;
}

async function seedV1Database(): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(upgradeDb) {
      const rootStore = upgradeDb.createObjectStore('root-handles', { keyPath: 'folderId' });
      rootStore.createIndex('by-last-accessed', 'lastAccessedAt');
      const fileStore = upgradeDb.createObjectStore('file-handles', { keyPath: 'path' });
      fileStore.createIndex('by-folder', 'folderId');
    },
  });
  await db.put('root-handles', {
    folderId: 'my-project',
    handle: makeDirectoryHandle('my-project'),
    lastAccessedAt: 100,
    name: 'my-project',
    storedAt: 100,
  });
  await db.put('file-handles', {
    folderId: 'my-project',
    handle: makeDirectoryHandle('stale'),
    name: 'file.ts',
    path: 'my-project::src/file.ts',
    storedAt: 100,
  });
  db.close();
}

describe('WebHandleCache v1→v2 upgrade', () => {
  beforeEach(() => {
    // Replace the shared fake-indexeddb instance with a fresh one per test
    // so there are no open connections to block operations and no cross-test
    // state leakage.  The IDB globals (IDBRequest, etc.) remain from the
    // fake-indexeddb/auto import above.
    globalThis.indexedDB = new IDBFactory();
  });

  it('discards v1 name-keyed root records on upgrade (greenfield: no data migration)', async () => {
    await seedV1Database();

    const cache = new WebHandleCache();
    const roots = await cache.getAllRootHandles();

    expect(roots).toEqual([]);
  });

  it('drops v1 file-handle records during upgrade (best-effort cache)', async () => {
    await seedV1Database();

    const cache = new WebHandleCache();
    await cache.getAllRootHandles(); // force open/upgrade
    const fileHandle = await cache.getFileHandle('my-project', 'src/file.ts');
    expect(fileHandle).toBeNull();
  });

  it('fresh database opens at v2 and stores roots under caller-provided RootIds', async () => {
    const cache = new WebHandleCache();
    const rootId = crypto.randomUUID();
    await cache.storeRootHandle(rootId, makeDirectoryHandle('docs'));

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.folderId).toBe(rootId);
    expect(roots[0]?.name).toBe('docs');
  });

  it('two same-named directories coexist under distinct RootIds (the v1 collision)', async () => {
    const cache = new WebHandleCache();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await cache.storeRootHandle(a, makeDirectoryHandle('docs'));
    await cache.storeRootHandle(b, makeDirectoryHandle('docs'));

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((r) => r.folderId))).toEqual(new Set([a, b]));
  });
});
