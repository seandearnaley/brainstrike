import path from 'node:path';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
  type WorkspaceRootStorage,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { WorkspaceRootPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import { type Mock, vi } from 'vitest';

export function registryRoot(
  id: string,
  rootPath: string,
  kind: 'path' | 'worktree' = 'path'
): WorkspaceRootRecord {
  return {
    canonicalPath: rootPath,
    createdAt: 1,
    displayName: path.basename(rootPath),
    id,
    kind,
    lastVerifiedAt: 1,
    path: rootPath,
    status: 'live',
  };
}

export function createRegistryCatalogRequest(
  initial: readonly WorkspaceRootRecord[] = []
): Mock<WorkspaceRootPort['workspaceRoots']> {
  const roots = new Map(initial.map((root) => [root.path, root]));
  // The catalog's open order (`open_position`): a registered folder opens; a closed one leaves it.
  const open = initial.filter((root) => root.status === 'live').map((root) => root.id);
  return vi.fn(async (request) => {
    switch (request.operation) {
      case 'list':
        return { roots: [...roots.values()] };
      case 'list-open': {
        const byId = new Map([...roots.values()].map((root) => [root.id, root]));
        return { roots: open.flatMap((id) => byId.get(id) ?? []) };
      }
      case 'register': {
        const previous = roots.get(request.root.path);
        if (previous && previous.canonicalPath !== request.root.canonicalPath && !request.repin) {
          throw new Error('The workspace folder at this path is not the one that was granted');
        }
        // A picker re-pin moves the folder's record to the path just picked, keeping its id.
        const moved = request.repin
          ? [...roots.values()].find((root) => root.id === request.root.preferredId)
          : undefined;
        if (!previous && moved) {
          roots.delete(moved.path);
        }
        const root = {
          ...(previous ??
            (moved
              ? { ...moved, path: request.root.path }
              : registryRoot(request.root.preferredId, request.root.path))),
          canonicalPath: request.root.canonicalPath,
          status: 'live' as const,
        };
        roots.set(root.path, root);
        if (!open.includes(root.id)) {
          open.push(root.id);
        }
        return { roots: [root] };
      }
      case 'disconnect-except': {
        for (const id of request.closeRootIds ?? []) {
          const index = open.indexOf(id);
          if (index >= 0) {
            open.splice(index, 1);
          }
        }
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

/** The recent-folders ledger's key-value store (the host keeps it in its settings). */
/** A catalog whose open folders are these saved entries, in order. */
export function openRootsCatalog(
  entries: readonly {
    readonly addedAt: number;
    /** The identity the folder was granted under; its own path unless a test says otherwise. */
    readonly canonicalPath?: string;
    readonly path: string;
    readonly rootId: string;
  }[]
): Mock<WorkspaceRootPort['workspaceRoots']> {
  return createRegistryCatalogRequest(
    entries.map((entry) => ({
      ...registryRoot(entry.rootId, entry.path),
      canonicalPath: entry.canonicalPath ?? path.normalize(entry.path),
      createdAt: entry.addedAt,
    }))
  );
}

/** The open folders the catalog records, in order. */
export async function listOpenRoots(
  catalog: Mock<WorkspaceRootPort['workspaceRoots']>
): Promise<{ path: string; rootId: string }[]> {
  const { roots } = await catalog({ operation: 'list-open' });
  return roots.map((root) => ({ path: root.path, rootId: root.id }));
}

export function createStorage(initial: Record<string, string> = {}): WorkspaceRootStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
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
    recents: createStorage(),
    ...overrides,
  });
}
