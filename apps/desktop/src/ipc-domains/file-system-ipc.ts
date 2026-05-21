import path from 'node:path';
import type { DirectoryHandle, FileHandle, SerializableFileNode } from '@brainstrike/file-system';
import { AccessError, getTestDirectoryStructure } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain } from 'electron';
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
const MOCK_PATH_PREFIX = '/mock/' as const;
const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;
const logger = createLogger('FileSystemIpc');

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

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess, async () => {
    const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
    const nodeEnv = process.env['NODE_ENV'];
    const isTestMode =
      process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';

    if (isTestMode) {
      const fixture = getElectronE2eFileSystemFixture();
      if (fixture) {
        fixture.requestDirectoryAccessCount += 1;
        return fixture.rootHandle;
      }
      return {
        id: 'mock-directory-handle',
        kind: 'directory',
        name: 'mock-test-directory',
        path: '/mock/test/directory',
        platform: 'electron',
        type: 'directory',
      };
    }

    return fileSystem.requestDirectoryAccess();
  });

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
    async (_event, requestedPath: string) => {
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
  );

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.restoreLastFolder, async () => {
    try {
      const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);
      if (!lastFolderPath) {
        return null;
      }

      const resolvedPath = await resolveFileSystemIpcPath(lastFolderPath, 'stored folder');
      const exists = await fileSystem.exists(resolvedPath);
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
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Auto-restore failed', { error });
      }
      return null;
    }
  });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.saveLastFolder,
    async (_event, folderPath: string) => {
      try {
        const resolvedPath = await resolveFileSystemIpcPath(folderPath, 'last folder');
        await storage.setItem(LAST_FOLDER_STORAGE_KEY, resolvedPath);
      } catch (error) {
        if (process.env['NODE_ENV'] === 'development') {
          logger.debug('Failed to save last folder', { error });
        }
      }
    }
  );

  return () => registry.unregisterAll();
}
