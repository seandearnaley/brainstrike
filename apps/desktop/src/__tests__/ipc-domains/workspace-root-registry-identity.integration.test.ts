import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import { WorkspaceRootRegistry } from '../../ipc-domains/workspace-root-registry';

/**
 * BST-1990: a workspace folder has one id, its `roots.id`, and Main's root
 * registry is the one writer of that record. Removing a folder keeps its row
 * (disconnected); re-adding the same path resolves to that row's id instead of
 * minting a second one; a restart restores the same id.
 */

function createStorage(): ElectronStorageAdapter {
  const values = new Map<string, string>();
  return {
    clear: vi.fn(async () => values.clear()),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

function createRegistry(
  storage: ElectronStorageAdapter,
  db: WorkspaceRootsQueryable
): WorkspaceRootRegistry {
  return new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: vi.fn(async () => 0),
    evictLspServersForRoot: vi.fn(async () => undefined),
    getRootsDatabase: async () => db,
    pathExists: async (rootPath) =>
      access(rootPath).then(
        () => true,
        () => false
      ),
    storage,
  });
}

async function openRootsDatabase(name: string): Promise<WorkspaceRootsQueryable> {
  const db = await wasmLoader.createPGlite(`memory://${name}`);
  await migrate(db);
  return db as unknown as WorkspaceRootsQueryable;
}

async function rootRows(db: WorkspaceRootsQueryable) {
  return (
    await db.query<{ id: string; kind: string; path: string; status: string }>(
      'SELECT id, kind, path, status FROM roots ORDER BY path'
    )
  ).rows;
}

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function workspaceFolder(name: string): Promise<string> {
  const fixture = await mkdtemp(path.join(tmpdir(), 'brainstrike-root-identity-'));
  cleanup.push(fixture);
  const folder = path.join(fixture, name);
  await mkdir(folder);
  return folder;
}

it('keeps one id for a folder, its roots row, across add, remove, re-add and restart', async () => {
  const folder = await workspaceFolder('workspace');
  const handle = {
    kind: 'directory',
    name: 'workspace',
    path: folder,
    platform: 'electron',
  } as const;
  const db = await openRootsDatabase('root-identity-lifecycle');
  const storage = createStorage();
  const registry = createRegistry(storage, db);

  const added = await registry.addRoot(handle);
  expect(await rootRows(db)).toEqual([
    { id: added.rootId, kind: 'path', path: folder, status: 'live' },
  ]);

  await registry.removeRoot(added.rootId);
  expect(await rootRows(db)).toEqual([
    { id: added.rootId, kind: 'path', path: folder, status: 'disconnected' },
  ]);

  const readded = await registry.addRoot(handle);
  expect(readded.rootId).toBe(added.rootId);
  expect(await rootRows(db)).toEqual([
    { id: added.rootId, kind: 'path', path: folder, status: 'live' },
  ]);
  await registry.dispose();

  const restarted = createRegistry(storage, db);
  const restored = await restarted.restoreRoots();
  expect(restored.map((root) => [root.rootId, root.permissionState])).toEqual([
    [added.rootId, 'granted'],
  ]);
  expect(await rootRows(db)).toEqual([
    { id: added.rootId, kind: 'path', path: folder, status: 'live' },
  ]);
  await restarted.dispose();
});

it('records a mounted managed worktree with the worktree kind', async () => {
  const folder = await workspaceFolder('managed-checkout');
  const db = await openRootsDatabase('root-identity-worktree');
  await db.query(
    `INSERT INTO brainstrike_worktrees (id, repo_common_dir, path, base_ref, created_by)
     VALUES ('worktree-1', '/repo/.git', $1, 'main', 'agent')`,
    [folder]
  );
  const registry = createRegistry(createStorage(), db);
  const added = await registry.addRoot(
    { kind: 'directory', name: 'managed-checkout', path: folder, platform: 'electron' },
    { recordInRecentRoots: false }
  );
  expect(await rootRows(db)).toEqual([
    { id: added.rootId, kind: 'worktree', path: folder, status: 'live' },
  ]);
  await registry.dispose();
});

it('keeps the same folder id when disconnected and re-added through another path spelling', async () => {
  const folder = await workspaceFolder('canonical-workspace');
  const alias = path.join(path.dirname(folder), 'workspace-alias');
  await symlink(folder, alias, 'dir');
  const db = await openRootsDatabase('root-identity-path-spelling');
  const storage = createStorage();
  const registry = createRegistry(storage, db);
  try {
    const added = await registry.addRoot({
      kind: 'directory',
      name: 'workspace-alias',
      path: alias,
      platform: 'electron',
    });
    await registry.removeRoot(added.rootId);
    const readded = await registry.addRoot({
      kind: 'directory',
      name: 'canonical-workspace',
      path: folder,
      platform: 'electron',
    });
    expect(readded.rootId).toBe(added.rootId);
    expect(await rootRows(db)).toEqual([
      { id: added.rootId, kind: 'path', path: alias, status: 'live' },
    ]);
    await registry.dispose();
    const restarted = createRegistry(storage, db);
    try {
      const restored = await restarted.restoreRoots();
      expect(restored.map((root) => root.rootId)).toEqual([added.rootId]);
      expect(await rootRows(db)).toEqual([
        { id: added.rootId, kind: 'path', path: alias, status: 'live' },
      ]);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await registry.dispose();
  }
});
