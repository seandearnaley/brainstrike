import path from 'node:path';
import type { DirectoryHandle, FileHandle, SerializableFileNode } from '@brainstrike/file-system';
import { AccessError, getTestDirectoryStructure } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain } from 'electron';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_NOT_FOUND,
  type FileReadErrorPayload,
  isFileNotFoundError,
} from '../file-read-errors';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';

interface RegisterFileSystemIpcHandlersOptions {
  readonly fileSystem: ElectronFileSystemAdapter;
  readonly storage: ElectronStorageAdapter;
}

interface ElectronE2eFileSystemFixture {
  readonly directoriesByPath: Record<string, SerializableFileNode[]>;
  readonly fileContentsByPath: Record<string, string>;
  readonly readDirectoryCalls: string[];
  readonly readFileByPathCalls: string[];
  readonly readFileCalls: string[];
  requestDirectoryAccessCount: number;
  readonly rootHandle: DirectoryHandle & {
    readonly id: string;
    readonly type: 'directory';
  };
}

const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;
const ROOTS_LIST_STORAGE_KEY = 'rootsList' as const;
const MOCK_PATH_PREFIX = '/mock/' as const;
const E2E_REAL_ROOT_PATH_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH' as const;
const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;
const logger = createLogger('FileSystemIpc');

interface StoredRootEntry {
  addedAt: number;
  path: string;
  rootId: string;
}

function isStoredRootEntry(value: unknown): value is StoredRootEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['addedAt'] === 'number' &&
    typeof candidate['path'] === 'string' &&
    typeof candidate['rootId'] === 'string'
  );
}

async function readRootsList(storage: ElectronStorageAdapter): Promise<StoredRootEntry[]> {
  const raw = await storage.getItem(ROOTS_LIST_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('Failed to parse rootsList — treating as empty', { error });
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn('rootsList storage value is not an array — treating as empty', {
      key: ROOTS_LIST_STORAGE_KEY,
    });
    return [];
  }
  const valid = parsed.filter(isStoredRootEntry);
  if (valid.length !== parsed.length) {
    logger.warn('rootsList contained malformed entries — discarding invalid items', {
      total: parsed.length,
      valid: valid.length,
    });
  }
  return valid;
}

async function writeRootsList(
  storage: ElectronStorageAdapter,
  entries: StoredRootEntry[]
): Promise<void> {
  await storage.setItem(ROOTS_LIST_STORAGE_KEY, JSON.stringify(entries));
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

async function resolveFileSystemIpcPath(
  requestedPath: unknown,
  operation: string
): Promise<string> {
  if (typeof requestedPath === 'string' && isWindowsAbsolutePath(requestedPath)) {
    if (requestedPath.includes('\0')) {
      throw new Error(`Invalid ${operation} path: Requested path contains null bytes.`);
    }
    return requestedPath;
  }

  const resolved = await resolveValidatedPath({ requestedPath });
  if (resolved.ok) {
    return resolved.path;
  }
  throw new Error(`Invalid ${operation} path: ${resolved.error.message}`);
}

async function resolveDirectoryHandle(handle: DirectoryHandle): Promise<DirectoryHandle> {
  const resolvedPath = await resolveFileSystemIpcPath(handle?.path, 'directory handle');
  return { ...handle, path: resolvedPath };
}

async function resolveFileHandle(handle: FileHandle): Promise<FileHandle> {
  const resolvedPath = await resolveFileSystemIpcPath(handle?.path, 'file handle');
  return { ...handle, path: resolvedPath };
}

function getElectronE2eFileSystemFixture(): ElectronE2eFileSystemFixture | null {
  const fixture = (
    globalThis as typeof globalThis & {
      [E2E_FILE_SYSTEM_FIXTURE_KEY]?: ElectronE2eFileSystemFixture;
    }
  )[E2E_FILE_SYSTEM_FIXTURE_KEY];
  return fixture ?? null;
}

function isE2eTestMode(): boolean {
  return (
    process.argv.includes('--test-mode') ||
    process.env['ELECTRON_IS_E2E_TEST'] === 'true' ||
    process.env['NODE_ENV'] === 'test'
  );
}

async function resolveE2eRealRootDirectoryHandle(
  fileSystem: ElectronFileSystemAdapter
): Promise<DirectoryHandle | null> {
  const configuredPath = process.env[E2E_REAL_ROOT_PATH_ENV]?.trim();
  if (!configuredPath) {
    return null;
  }
  const resolvedPath = await resolveFileSystemIpcPath(configuredPath, E2E_REAL_ROOT_PATH_ENV);
  const exists = await fileSystem.exists(resolvedPath);
  if (!exists) {
    throw new Error(
      `${E2E_REAL_ROOT_PATH_ENV} points to a path that does not exist: ${resolvedPath}`
    );
  }
  return {
    kind: 'directory',
    name: path.basename(resolvedPath),
    path: resolvedPath,
    platform: 'electron',
  };
}

/**
 * Resolve the picked directory handle for access-request flows. In test mode
 * the OS dialog cannot open, so the registered E2E fixture's root handle (or
 * the default mock handle) is returned WITHOUT touching the real adapter —
 * the real `requestDirectoryAccess` stats the picked path, which fails with
 * ENOENT for mock paths. Shared by fs:requestDirectoryAccess and fs:addRoot
 * so both pick flows follow the exact same test-mode contract.
 *
 * Precedence: a fixture registered by the CURRENT test beats the
 * BRAINSTRIKE_E2E_REAL_ROOT_PATH env opt-in — the env var is process-wide and
 * can leak across test files sharing a Playwright worker, while a registered
 * fixture is an explicit per-session choice.
 */
async function resolveRequestedDirectoryHandle(
  fileSystem: ElectronFileSystemAdapter
): Promise<DirectoryHandle> {
  if (isE2eTestMode()) {
    const fixture = getElectronE2eFileSystemFixture();
    if (fixture) {
      fixture.requestDirectoryAccessCount += 1;
      return fixture.rootHandle;
    }
    const realRootHandle = await resolveE2eRealRootDirectoryHandle(fileSystem);
    if (realRootHandle) {
      return realRootHandle;
    }
    return {
      id: 'mock-directory-handle',
      kind: 'directory',
      name: 'mock-test-directory',
      path: '/mock/test/directory',
      platform: 'electron',
      type: 'directory',
    } as DirectoryHandle;
  }

  return fileSystem.requestDirectoryAccess();
}

/**
 * Existence check shared by the fs:exists channel and stored-root pruning
 * (fs:restoreRoots). Consults the registered E2E fixture first, then treats
 * mock-prefixed paths as existing (mirrors every other mock-aware handler in
 * this file) — a raw `fileSystem.exists` here would stat the real disk and
 * silently prune e2e-seeded roots from rootsList.
 */
async function ipcPathExists(
  fileSystem: ElectronFileSystemAdapter,
  requestedPath: string
): Promise<boolean> {
  const fixture = getElectronE2eFileSystemFixture();
  if (fixture) {
    return (
      requestedPath === fixture.rootHandle.path ||
      requestedPath in fixture.directoriesByPath ||
      requestedPath in fixture.fileContentsByPath
    );
  }

  if (requestedPath.startsWith(MOCK_PATH_PREFIX)) {
    return true;
  }

  const resolved = await resolveValidatedPath({ requestedPath });
  if (!resolved.ok) {
    logger.debug('Invalid path provided during exists check', {
      error: resolved.error,
      path: requestedPath,
    });
    return false;
  }

  return fileSystem.exists(resolved.path);
}

function hasTooLargeCode(error: unknown): error is { code: 'TOO_LARGE'; message?: unknown } {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === 'TOO_LARGE';
}

function getFileTooLargeMessage(error: unknown): string | null {
  if (hasTooLargeCode(error)) {
    if (error instanceof Error) {
      return error.message;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'File too large';
  }

  if (error instanceof AccessError && error.operation === 'read') {
    return error.message.includes('File too large') ? error.message : null;
  }
  if (error instanceof Error && error.message.startsWith('File too large:')) {
    return error.message;
  }
  return null;
}

function toFileReadErrorPayload(error: unknown, filePath: string): FileReadErrorPayload | null {
  const tooLargeMessage = getFileTooLargeMessage(error);
  if (tooLargeMessage) {
    logger.debug('Skipping oversized file read', { message: tooLargeMessage, path: filePath });
    return createFileReadErrorPayload(tooLargeMessage);
  }
  if (isFileNotFoundError(error)) {
    logger.debug('File not found during read', { path: filePath });
    return createFileReadErrorPayload(
      error instanceof Error ? error.message : 'File not found',
      FILE_READ_ERROR_CODE_NOT_FOUND
    );
  }
  return null;
}

export function registerFileSystemIpcHandlers({
  fileSystem,
  storage,
}: RegisterFileSystemIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess, async () =>
    resolveRequestedDirectoryHandle(fileSystem)
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.readDirectory,
    async (_event, handle: DirectoryHandle) => {
      const fixture = getElectronE2eFileSystemFixture();
      if (fixture) {
        fixture.readDirectoryCalls.push(handle.path);
        const entries = fixture.directoriesByPath[handle.path];
        if (!entries) {
          throw new AccessError(
            `Failed to read directory: no E2E fixture registered for ${handle.path}`,
            handle.path,
            'read'
          );
        }
        return entries;
      }

      if (
        handle &&
        typeof handle === 'object' &&
        'id' in handle &&
        handle.id === 'mock-directory-handle'
      ) {
        const rootPath = '/mock/test/directory';
        return getTestDirectoryStructure(rootPath);
      }
      return fileSystem.readDirectory(await resolveDirectoryHandle(handle));
    }
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.readFile,
    async (_event, handle: FileHandle) => {
      const fixture = getElectronE2eFileSystemFixture();
      if (fixture) {
        fixture.readFileCalls.push(handle.path);
        const content = fixture.fileContentsByPath[handle.path];
        if (content === undefined) {
          throw new AccessError(
            `Failed to read file: no E2E fixture registered for ${handle.path}`,
            handle.path,
            'read'
          );
        }
        return content;
      }

      if (
        handle &&
        typeof handle === 'object' &&
        'id' in handle &&
        String(handle.id).includes('mock-')
      ) {
        return 'Mock file content for testing purposes\nThis is a test file.\n';
      }
      try {
        const resolvedHandle = await resolveFileHandle(handle);
        return await fileSystem.readFile(resolvedHandle);
      } catch (error) {
        const payload = toFileReadErrorPayload(error, handle?.path ?? '');
        if (payload) {
          return payload;
        }
        throw error;
      }
    }
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.readFileByPath,
    async (_event, absolutePath: string) => {
      const fixture = getElectronE2eFileSystemFixture();
      if (fixture) {
        fixture.readFileByPathCalls.push(absolutePath);
        const content = fixture.fileContentsByPath[absolutePath];
        if (content === undefined) {
          throw new AccessError(
            `Failed to read file by path: no E2E fixture registered for ${absolutePath}`,
            absolutePath,
            'read'
          );
        }
        return content;
      }

      if (absolutePath.startsWith(MOCK_PATH_PREFIX)) {
        return 'Mock file content for testing purposes\nThis is a test file.\n';
      }

      const resolved = await resolveValidatedPath({ requestedPath: absolutePath });
      if (!resolved.ok) {
        throw new Error(`Invalid path: ${resolved.error}`);
      }

      try {
        return await fileSystem.readFileByPath(resolved.path);
      } catch (error) {
        const payload = toFileReadErrorPayload(error, resolved.path);
        if (payload) {
          return payload;
        }
        throw error;
      }
    }
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.exists,
    async (_event, requestedPath: string) => ipcPathExists(fileSystem, requestedPath)
  );

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.restoreLastFolder, async () => {
    const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);
    if (!lastFolderPath) {
      return null;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await resolveFileSystemIpcPath(lastFolderPath, 'stored folder');
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Auto-restore failed', { error });
      }
      return null;
    }

    let exists: boolean;
    try {
      // Mock-aware existence (same class as restoreRoots — see ipcPathExists).
      exists = await ipcPathExists(fileSystem, resolvedPath);
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Auto-restore failed', { error });
      }
      return null;
    }

    if (!exists) {
      await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
      return null;
    }

    const handle: DirectoryHandle = {
      kind: 'directory',
      name: path.basename(resolvedPath),
      path: resolvedPath,
      platform: 'electron',
    };
    return handle;
  });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.saveLastFolder,
    async (_event, folderPath: string) => {
      let resolvedPath: string;
      try {
        resolvedPath = await resolveFileSystemIpcPath(folderPath, 'last folder');
      } catch (error) {
        if (process.env['NODE_ENV'] === 'development') {
          logger.debug('Failed to save last folder', { error });
        }
        return;
      }

      await storage.setItem(LAST_FOLDER_STORAGE_KEY, resolvedPath);
      const entries = await readRootsList(storage);
      const existing = entries.find((entry) => entry.path === resolvedPath);
      if (!existing) {
        const newEntry: StoredRootEntry = {
          addedAt: Date.now(),
          path: resolvedPath,
          rootId: crypto.randomUUID(),
        };
        await writeRootsList(storage, [...entries, newEntry]);
      }
    }
  );

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.restoreRoots, async () => {
    const entries = await readRootsList(storage);
    if (entries.length === 0) {
      return [];
    }

    const survivors: StoredRootEntry[] = [];
    const descriptors: RootDescriptor[] = [];

    for (const entry of entries) {
      try {
        const resolvedPath = await resolveFileSystemIpcPath(entry.path, 'stored root');
        // Mock-aware existence: a raw fileSystem.exists would stat the real
        // disk and prune e2e-seeded mock roots (see ipcPathExists).
        const exists = await ipcPathExists(fileSystem, resolvedPath);
        if (!exists) {
          logger.debug('Pruning stale root from rootsList', { path: entry.path });
          continue;
        }
        const basename = path.basename(resolvedPath);
        survivors.push(entry);
        descriptors.push({
          displayName: basename,
          handle: {
            kind: 'directory',
            name: basename,
            path: resolvedPath,
            platform: 'electron',
          },
          kind: 'path',
          permissionState: 'granted',
          persisted: true,
          rootId: entry.rootId,
        });
      } catch (error) {
        logger.debug('Skipping invalid root entry during restore', { error, path: entry.path });
      }
    }

    if (survivors.length !== entries.length) {
      await writeRootsList(storage, survivors);
    }

    return descriptors;
  });

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.addRoot, async () => {
    // Test-mode aware (same contract as fs:requestDirectoryAccess): the real
    // adapter stats the picked path, which ENOENTs on e2e mock paths.
    const handle = await resolveRequestedDirectoryHandle(fileSystem);
    const resolvedPath = await resolveFileSystemIpcPath(handle.path, 'added root');
    const basename = path.basename(resolvedPath);

    // Upsert into rootsList keyed by resolved path.
    // No mutex: these handlers are user-gesture-driven (single dialog at a time).
    // Concurrent RMW is only possible across multiple renderer windows, which is
    // not yet a use case. Revisit if programmatic addRoot calls are introduced.
    const entries = await readRootsList(storage);
    const existing = entries.find((e) => e.path === resolvedPath);

    let rootId: string;
    let persisted = true;

    if (existing) {
      rootId = existing.rootId;
      const updated: StoredRootEntry[] = entries.map((e) =>
        e.path === resolvedPath ? { ...e, addedAt: Date.now() } : e
      );
      try {
        await writeRootsList(storage, updated);
      } catch (error) {
        // The root is ALREADY durably stored — a failed addedAt bump does not
        // change that. Per the RootDescriptor.persisted contract, persisted
        // stays true: reporting false here would make callers skip DB
        // registration for a perfectly durable root.
        logger.warn('addRoot: failed to bump addedAt on existing rootsList entry', { error });
      }
    } else {
      rootId = crypto.randomUUID();
      const newEntry: StoredRootEntry = { addedAt: Date.now(), path: resolvedPath, rootId };
      try {
        await writeRootsList(storage, [...entries, newEntry]);
      } catch (error) {
        logger.warn('addRoot: failed to write rootsList', { error });
        persisted = false;
      }
    }

    // Shim parity: keep writing lastFolderPath
    try {
      await storage.setItem(LAST_FOLDER_STORAGE_KEY, resolvedPath);
    } catch (error) {
      logger.warn('addRoot: failed to write lastFolderPath', { error });
    }

    const descriptor: RootDescriptor = {
      displayName: basename,
      handle: {
        kind: 'directory',
        name: basename,
        path: resolvedPath,
        platform: 'electron',
      },
      kind: 'path',
      permissionState: 'granted',
      persisted,
      rootId,
    };
    return descriptor;
  });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.removeRoot,
    async (_event, rootId: string) => {
      // Disconnect ≠ delete: this forgets ONLY the stored rootsList entry (and
      // a matching lastFolderPath). It NEVER touches the DB — all
      // roots/file_records/file_chunks rows are deliberately KEPT so re-adding
      // the same folder reuses its rootId and resumes without re-indexing.
      const entries = await readRootsList(storage);
      const removed = entries.find((entry) => entry.rootId === rootId);
      if (!removed) {
        logger.debug('removeRoot: rootId not found in rootsList — nothing to remove', { rootId });
        return;
      }

      const remaining = entries.filter((entry) => entry.rootId !== rootId);
      await writeRootsList(storage, remaining);

      // Tear down any pooled LSP language server for this root (report R2): the
      // folder is leaving the workspace, so its server child process must not
      // linger. Non-fatal — a stray server would otherwise idle until quit.
      await evictLspServersForRoot(rootId).catch((error: unknown) => {
        logger.debug('removeRoot: LSP server eviction failed (non-fatal)', { error, rootId });
      });

      // Keep the dual stores coherent: clear lastFolderPath only when it points
      // at the removed root's path.
      const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);
      if (lastFolderPath === removed.path) {
        await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
      }
    }
  );

  return () => registry.unregisterAll();
}
