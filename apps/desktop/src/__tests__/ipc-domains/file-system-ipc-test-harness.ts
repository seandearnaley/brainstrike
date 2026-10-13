import path from 'node:path';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';

/**
 * Shared seams for the file-system IPC domain suites. Each Vitest file gets its
 * own module instance, so the handler map and mocks below never leak between
 * files — only within a file, which is what the per-suite `beforeEach` resets.
 */

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;

/** Channels registered by `registerFileSystemIpcHandlers`, keyed by channel name. */
export const handlers = new Map<string, IpcHandler>();

export const removeHandler = vi.fn((channel: string) => {
  handlers.delete(channel);
});

/**
 * Electron stand-in. `vi.mock` factories are hoisted above imports, so consumers
 * must pull this in from inside the factory:
 *
 * ```ts
 * vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);
 * ```
 */
export const electronMock = {
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
};

// Shared roots-DB seam for the fs:removeRoot status transition. Resolves an
// empty result by default; individual tests override with mock*Once.
export const rootsDbQuery = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
  rows: [] as unknown[],
}));
export const rootsDatabase = { query: rootsDbQuery } as unknown as WorkspaceRootsQueryable;
export const getRootsDatabase = vi.fn(async () => rootsDatabase);

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

/** Drop any fixture a previous test registered on the process-wide global. */
export function clearE2eFileSystemFixture(): void {
  delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
}

export function setE2eFileSystemFixture(fixture: unknown): void {
  (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY] =
    fixture;
}

/** Functional consumer: decode the actual registered Main handler's wire result. */
export function capabilityHandler(channel: string): IpcHandler {
  return async (event, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Unregistered filesystem channel: ${channel}`);
    }
    return readBoundaryResult(await handler(event, ...args));
  };
}
