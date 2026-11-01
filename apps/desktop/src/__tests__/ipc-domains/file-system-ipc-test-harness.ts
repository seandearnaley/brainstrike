import path from 'node:path';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { SecureWorkspaceRoot } from '@brainstrike/assistant-service/node-workspace-services';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { WorkspaceRootPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { vi } from 'vitest';
import { invokeDesktopIpcFrom } from '../helpers/desktop-ipc-sender-test-helpers';

/**
 * Shared seams for the file-system IPC domain suites. Each Vitest file gets its
 * own module instance, so the mocks below never leak between files. Within a
 * file the IPC methods stay registered until their domain closes, so every
 * suite closes what it registers.
 */

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Electron stand-in. `vi.mock` factories are hoisted above imports, so consumers
 * must pull this in from inside the factory:
 *
 * ```ts
 * vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);
 * ```
 */
export const electronMock = {
  ipcMain: { handle: vi.fn() },
};

const roots = new Map<string, WorkspaceRootRecord>();
export const rootsCatalogRequest = vi.fn<WorkspaceRootPort['workspaceRoots']>(async (request) => {
  if (request.operation === 'list') {
    return { roots: [...roots.values()] };
  }
  if (request.operation === 'register') {
    const previous = roots.get(request.root.path);
    const root: WorkspaceRootRecord = {
      createdAt: 1,
      displayName: request.root.displayName,
      id: previous?.id ?? request.root.preferredId,
      kind: 'path',
      lastVerifiedAt: 1,
      path: request.root.path,
      status: 'live',
    };
    roots.set(root.path, root);
    return { roots: [root] };
  }
  if (request.operation === 'disconnect-except') {
    const disconnected = [...roots.values()]
      .filter((root) => root.status === 'live' && !request.mountedPaths.includes(root.path))
      .map((root): WorkspaceRootRecord => ({ ...root, status: 'disconnected' }));
    for (const root of disconnected) {
      roots.set(root.path, root);
    }
    return { roots: disconnected };
  }
  throw new Error('Unexpected content deletion in the filesystem grant fixture');
});
export const getRootsCatalog = vi.fn(async () => ({ workspaceRoots: rootsCatalogRequest }));
export function resetRootsCatalog(): void {
  roots.clear();
  rootsCatalogRequest.mockClear();
  getRootsCatalog.mockClear();
}

export function makeDirHandle(dirPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(dirPath),
    path: dirPath,
    platform: 'electron',
  };
}

export function createFileSystem(pickedPath = '/real-dir'): ElectronFileSystemAdapter {
  return {
    exists: vi.fn(async () => true),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    readFileByPath: vi.fn(async () => 'path content'),
    requestDirectoryAccess: vi.fn(async () => makeDirHandle(pickedPath)),
    watchDirectory: vi.fn(),
  } as unknown as ElectronFileSystemAdapter;
}

export function createStorage(storedItems: Record<string, string> = {}): ElectronStorageAdapter {
  const store: Record<string, string> = { ...storedItems };
  return {
    clear: vi.fn(async () => undefined),
    getAllKeys: vi.fn(async () => Object.keys(store)),
    getItem: vi.fn(async (key: string) => store[key] ?? null),
    removeItem: vi.fn(async (key: string) => {
      delete store[key];
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
  } as unknown as ElectronStorageAdapter;
}

/**
 * Registry seams for a root with nothing on disk: its capability opens at the
 * path asked for and lists nothing, so the suites drive grants, not reads.
 */
export const inMemoryRootSeams = {
  createSecureRoot: async (rootPath: string): Promise<SecureWorkspaceRoot> => ({
    canonicalPath: path.normalize(rootPath),
    close: () => undefined,
    listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
    readFile: async () => ({ status: 'not-found' as const }),
  }),
  resolveReadPath: async (requestedPath: string) => path.normalize(requestedPath),
};

/** `method` as the renderer calls it from `event`'s sender: the raw wire result. */
export function ipcMethod(method: string): IpcHandler {
  return (event, ...args) => invokeDesktopIpcFrom(electronMock.ipcMain, event, method, ...args);
}

/** Functional consumer: decode the actual registered Main method's wire result. */
export function capabilityHandler(method: string): IpcHandler {
  return async (event, ...args) => readBoundaryResult(await ipcMethod(method)(event, ...args));
}
