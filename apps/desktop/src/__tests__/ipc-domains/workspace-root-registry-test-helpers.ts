import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { WorkspaceRootPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { type Mock, vi } from 'vitest';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

export function registryRoot(
  id: string,
  path: string,
  kind: 'path' | 'worktree' = 'path'
): WorkspaceRootRecord {
  return {
    createdAt: 1,
    displayName: path.split('/').at(-1) ?? path,
    id,
    kind,
    lastVerifiedAt: 1,
    path,
    status: 'live',
  };
}

export function createRegistryCatalogRequest(
  initial: readonly WorkspaceRootRecord[] = []
): Mock<WorkspaceRootPort['workspaceRoots']> {
  const roots = new Map(initial.map((root) => [root.path, root]));
  return vi.fn(async (request) => {
    switch (request.operation) {
      case 'list':
        return { roots: [...roots.values()] };
      case 'register': {
        const previous = roots.get(request.root.path);
        const root = {
          ...(previous ?? registryRoot(request.root.preferredId, request.root.path)),
          status: 'live' as const,
        };
        roots.set(root.path, root);
        return { roots: [root] };
      }
      case 'disconnect-except': {
        const disconnected = [...roots.values()]
          .filter((root) => root.status === 'live' && !request.mountedPaths.includes(root.path))
          .map((root) => ({ ...root, status: 'disconnected' as const }));
        for (const root of disconnected) {
          roots.set(root.path, root);
        }
        return { roots: disconnected };
      }
      case 'delete':
        throw new Error('Unexpected catalog deletion in a registry fixture');
    }
  });
}

export function createStorage(initial: Record<string, string> = {}): ElectronStorageAdapter {
  const values = new Map(Object.entries(initial));
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

export function rootHandle(rootPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(rootPath),
    path: rootPath,
    platform: 'electron',
  };
}

export function secureRoot(canonicalPath: string): SecureWorkspaceRoot {
  return {
    canonicalPath,
    close: vi.fn(),
    listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
    readFile: vi.fn(async () => ({ content: Buffer.from('inside'), status: 'ok' as const })),
  };
}

export function createRegistry(
  overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {},
  catalogRequest: Mock<WorkspaceRootPort['workspaceRoots']> = createRegistryCatalogRequest()
): WorkspaceRootRegistry {
  const catalog = { workspaceRoots: catalogRequest };
  return new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath) => secureRoot(rootPath),
    disposeCommandSessionsForRoot: vi.fn(async () => 0),
    evictLspServersForRoot: vi.fn(async () => undefined),
    getRootsCatalog: async () => catalog,
    pathExists: async () => true,
    resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
    storage: createStorage(),
    ...overrides,
  });
}
