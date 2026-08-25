import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { type Mock, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

export function createRegistryDatabaseQuery(): Mock<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
> {
  return vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
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
  dbQuery: Mock<
    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  > = createRegistryDatabaseQuery()
): WorkspaceRootRegistry {
  const db = { query: dbQuery } as unknown as WorkspaceRootsQueryable;
  return new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath) => secureRoot(rootPath),
    disposeCommandSessionsForRoot: vi.fn(async () => 0),
    evictLspServersForRoot: vi.fn(async () => undefined),
    getRootsDatabase: async () => db,
    pathExists: async () => true,
    resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
    storage: createStorage(),
    ...overrides,
  });
}
