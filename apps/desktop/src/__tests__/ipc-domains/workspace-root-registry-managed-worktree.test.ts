import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

// Split out of workspace-root-registry.test.ts (BST-1390, spec §6.2): that
// file is already at the react-doctor/Biome line cap, and these two tests
// cover a distinct concern — the managed-worktree authorizer wiring and the
// mounted-path listing it composes with — rather than growing the existing
// file further.

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

function rootHandle(rootPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(rootPath),
    path: rootPath,
    platform: 'electron',
  };
}

function secureRoot(canonicalPath: string): SecureWorkspaceRoot {
  return {
    canonicalPath,
    close: vi.fn(),
    listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
    readFile: vi.fn(async () => ({ content: Buffer.from('inside'), status: 'ok' as const })),
  };
}

describe('WorkspaceRootRegistry managed-worktree authorizer (BST-1390, spec §6.2)', () => {
  let dbQuery: ReturnType<typeof vi.fn>;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    storage = createStorage();
  });

  function createRegistry(
    overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {}
  ): WorkspaceRootRegistry {
    const db = { query: dbQuery } as unknown as WorkspaceRootsQueryable;
    return new WorkspaceRootRegistry({
      createSecureRoot: async (rootPath) => secureRoot(rootPath),
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      getRootsDatabase: async () => db,
      pathExists: async () => true,
      resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
      storage,
      ...overrides,
    });
  }

  it('routes addRootByPath through the installed managed-worktree authorizer', async () => {
    const registry = createRegistry();
    const authorizer = vi.fn(() => Promise.resolve(true));
    registry.setManagedWorktreeAuthorizer(authorizer);
    await registry.addRootByPath('/managed/app/bright-fox');
    expect(authorizer).toHaveBeenCalledWith('/managed/app/bright-fox');
  });

  it('lists the mounted root paths for the settings containment check', async () => {
    const registry = createRegistry();
    await registry.addRoot(rootHandle('/ws/alpha'));
    await expect(registry.listMountedRootPaths()).resolves.toEqual(['/ws/alpha']);
  });
});
