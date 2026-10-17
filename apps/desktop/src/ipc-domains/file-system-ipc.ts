import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  isFileNotFoundError,
  isWorkspaceRootRegistryDisposed,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { DirectoryHandle, FileHandle, SerializableFileNode } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  getFileTooLargeMessage,
  getTestDirectoryStructure,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IFileNode, RootDescriptor } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { disposeDesktopAndHostCommandSessionsForRoot } from '../agent-host-platform/host-command-session-client';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import { isDesktopShuttingDown, isExpectedShutdownRefusal } from '../desktop-shutdown-state';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_NOT_FOUND,
  type FileReadErrorPayload,
} from '../file-read-errors';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../platform/desktop-ipc-registry';
import type { IpcResult } from '../platform/ipc-contract';
import { fileSystemContract } from './file-system.contract';
import type { ManagedWorktreeAuthorizer } from './workspace-recent-roots';
import { type SecureWorkspaceRoot, WorkspaceRootRegistry } from './workspace-root-registry';

interface WorkspaceRootRegistryFileSystemSeams {
  readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly resolveReadPath: (requestedPath: string, canonicalRoot: string) => Promise<string>;
}

interface RegisterFileSystemIpcHandlersOptions {
  readonly disposeCommandSessionsForRoot?: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot?: (rootId: string) => Promise<void>;
  readonly fileSystem: ElectronFileSystemAdapter;
  /**
   * Main-process DB accessor for the roots status transition on disconnect
   * (fs:removeRoot). Required — the status column is what scopes the assistant
   * server's workspace tools, so a handler without it would silently keep
   * serving disconnected folders.
   */
  readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  /**
   * Explicit test-harness seam for roots backed by the in-memory adapter.
   * Production callers omit it and only registered mock paths are synthetic.
   */
  readonly isSyntheticFileSystemPath?: (rootPath: string) => boolean;
  readonly managedWorktreeAuthorizer?: ManagedWorktreeAuthorizer;
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
  /**
   * Fired after a successful grant-recording mount (BST-1393). main uses it to
   * push the folder into the OS recent-documents list and to rebuild the File
   * menu's Open Recent projection. Optional so every existing caller and test
   * is unaffected; a throwing subscriber must never fail the mount that
   * succeeded, so the call is wrapped.
   */
  readonly onWorkspaceRootGranted?: ((grantedPath: string) => void) | undefined;
  readonly storage: ElectronStorageAdapter;
  /** Explicit constructor seams for unit tests of native-root composition. */
  readonly workspaceRootRegistryFileSystemSeams?: WorkspaceRootRegistryFileSystemSeams;
}

interface ElectronE2eFileSystemFixture {
  readonly directoriesByPath: Record<string, SerializableFileNode[]>;
  /**
   * Opt-in per-read delay (ms) for fixture-served directory reads. Absent means
   * no delay, so every fixture that does not ask for one stays instant.
   *
   * Exists because a memory-served fixture resolves reads in microseconds,
   * which collapses cancellable traversals (expand-all) into a window too thin
   * for a Playwright round-trip to land inside. Mirrors the browser lane's
   * `directoryReadDelayMs` (packages/file-system/src/dev-fixture-types.ts).
   */
  readonly directoryReadDelayMs?: number;
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

const MOCK_PATH_PREFIX = '/mock/' as const;
const MOCK_ROOT_PATH = '/mock/test/directory' as const;
const E2E_REAL_ROOT_PATH_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH' as const;
const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;
const logger = createLogger('FileSystemIpc');

/**
 * BST-2118: a disposed workspace root registry refuses with a typed refusal, which
 * crosses IPC unlogged. The app's own shutdown is its only disposer, so a refusal
 * while quitting is expected (info, ADR-0015); at any other time it is an error.
 */
function settleFileSystemResult<T>(
  failure: { readonly category: string; readonly code: string },
  run: () => T | Promise<T>
): Promise<IpcResult<T>> {
  return settleIpcResult(failure, async () => {
    try {
      return await run();
    } catch (error) {
      if (isWorkspaceRootRegistryDisposed(error)) {
        if (isDesktopShuttingDown()) {
          logger.info('Workspace root registry refused work: the app is quitting', {
            operation: failure,
          });
        } else {
          logger.error('Workspace root registry refused work after it was disposed', {
            error,
            operation: failure,
          });
        }
      }
      throw error;
    }
  });
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

/**
 * Shared by this domain and the fs watch domain (file-system-watch-ipc.ts):
 * one validation path for every fs:* channel that accepts renderer paths.
 */
export async function resolveFileSystemIpcPath(
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

/**
 * True when a path is owned by the e2e mock file system (mock prefix or a
 * registered fixture) and must never touch the real disk. Shared with the fs
 * watch domain so mock roots get inert watchers instead of a native watcher on
 * nonexistent paths.
 */
export function isMockFileSystemIpcPath(requestedPath: string): boolean {
  const fixture = getElectronE2eFileSystemFixture();
  if (
    fixture &&
    (requestedPath === fixture.rootHandle.path ||
      requestedPath in fixture.directoriesByPath ||
      requestedPath in fixture.fileContentsByPath)
  ) {
    return true;
  }
  return requestedPath.startsWith(MOCK_PATH_PREFIX);
}

function getElectronE2eFileSystemFixture(): ElectronE2eFileSystemFixture | null {
  const fixture = (
    globalThis as typeof globalThis & {
      [E2E_FILE_SYSTEM_FIXTURE_KEY]?: ElectronE2eFileSystemFixture;
    }
  )[E2E_FILE_SYSTEM_FIXTURE_KEY];
  return fixture ?? null;
}

/**
 * Read the fixture's opt-in directory-read delay. The fixture arrives from an
 * untyped `globalThis` slot written by the E2E harness, so a malformed value
 * THROWS instead of falling back to zero: a silently ignored delay would hand
 * the test back the microsecond-wide window it was written to widen, and it
 * would pass for months before failing on a loaded CI runner.
 */
function resolveFixtureDirectoryReadDelayMs(fixture: ElectronE2eFileSystemFixture): number {
  const delayMs: unknown = fixture.directoryReadDelayMs;
  if (delayMs === undefined) {
    return 0;
  }
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(
      `Invalid E2E fixture directoryReadDelayMs: expected a finite number >= 0, received ${typeof delayMs} ${String(delayMs)}`
    );
  }
  return delayMs;
}

async function waitForFixtureDirectoryReadDelay(delayMs: number): Promise<void> {
  if (delayMs === 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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

  try {
    return await fileSystem.requestDirectoryAccess();
  } catch (cause) {
    if (cause instanceof UserCancelledError) {
      throw refusalError(
        'input',
        'workspace.selection-cancelled',
        'No folder was selected.',
        'Choose a folder to continue.'
      );
    }
    if (cause instanceof PermissionError) {
      throw new BoundaryFailureError(
        {
          category: 'authorization',
          code: 'workspace.permission-denied',
          kind: 'refusal',
          message: 'Access to the selected folder was denied.',
          remedy: 'Grant folder access in system settings, then choose it again.',
        },
        { cause }
      );
    }
    if (cause instanceof AccessError) {
      throw new BoundaryFailureError(
        {
          category: 'availability',
          code: 'workspace.directory-unavailable',
          kind: 'refusal',
          message: 'The selected folder is unavailable.',
          remedy: 'Choose an accessible folder.',
        },
        { cause }
      );
    }
    if (cause instanceof DialogError) {
      throw new BoundaryFailureError(
        fault({
          category: 'availability',
          code: 'workspace.picker-unavailable',
          message: 'The folder picker could not open.',
          remedy: 'Try opening the folder picker again.',
        }),
        { cause }
      );
    }
    throw cause;
  }
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

export interface FileSystemIpcDomain {
  close(): Promise<void>;
  readonly roots: WorkspaceRootRegistry;
  unregister(): void;
}

export function registerFileSystemIpcHandlers(
  options: RegisterFileSystemIpcHandlersOptions
): () => Promise<void> {
  return createFileSystemIpcDomain(options).close;
}

export function createFileSystemIpcDomain({
  disposeCommandSessionsForRoot = disposeDesktopAndHostCommandSessionsForRoot,
  evictLspServersForRoot: evictLspServersForRootOverride,
  fileSystem,
  getRootsCatalog,
  isSyntheticFileSystemPath = isMockFileSystemIpcPath,
  managedWorktreeAuthorizer,
  onWorkspaceRootGranted,
  onDeleteRootData,
  storage,
  workspaceRootRegistryFileSystemSeams,
}: RegisterFileSystemIpcHandlersOptions): FileSystemIpcDomain {
  const notifyRootGranted = (grantedPath: string): void => {
    try {
      onWorkspaceRootGranted?.(grantedPath);
    } catch (error) {
      logger.warn('workspace-root grant subscriber threw', { error });
    }
  };
  const evictLspServerForRoot = evictLspServersForRootOverride ?? evictLspServersForRoot;
  const registry = createDesktopIpcRegistry({ ipcMain });
  const syntheticFileSystemClassifications = new Map<string, boolean>();
  const bindSyntheticFileSystemClassification = (
    rootPath: string,
    classification: boolean
  ): void => {
    const classificationKey = path.normalize(rootPath);
    const cached = syntheticFileSystemClassifications.get(classificationKey);
    if (cached !== undefined && cached !== classification) {
      throw new Error('Conflicting filesystem classification for canonical workspace root.');
    }
    syntheticFileSystemClassifications.set(classificationKey, classification);
  };
  const usesSyntheticFileSystem = (rootPath: string): boolean => {
    const classificationKey = path.normalize(rootPath);
    const cached = syntheticFileSystemClassifications.get(classificationKey);
    if (cached !== undefined) {
      return cached;
    }
    const classification = isSyntheticFileSystemPath(rootPath);
    bindSyntheticFileSystemClassification(classificationKey, classification);
    return classification;
  };
  const roots = new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath): Promise<SecureWorkspaceRoot> => {
      if (usesSyntheticFileSystem(rootPath)) {
        return {
          canonicalPath: path.normalize(rootPath),
          close: () => undefined,
          listDir: async (relativePath, maxEntries) => {
            const directoryPath =
              relativePath === '.' ? rootPath : path.join(rootPath, relativePath);
            const nodes = await fileSystem.readDirectory({
              kind: 'directory',
              name: path.basename(directoryPath),
              path: directoryPath,
              platform: 'electron',
            });
            return {
              entries: nodes.slice(0, maxEntries).map((node) => ({
                isDirectory: node.type === 'directory',
                isFile: node.type === 'file',
                isSymbolicLink: false,
                ...(node.lastModified === undefined ? {} : { lastModified: node.lastModified }),
                name: node.name,
                ...(node.size === undefined ? {} : { size: node.size }),
              })),
              inspected: Math.min(nodes.length, maxEntries),
              truncated: nodes.length > maxEntries,
            };
          },
          readFile: async (relativePath) => {
            const filePath = path.join(rootPath, relativePath);
            const fixture = getElectronE2eFileSystemFixture();
            if (fixture && path.normalize(fixture.rootHandle.path) === path.normalize(rootPath)) {
              fixture.readFileByPathCalls.push(filePath);
              const fixtureContent = fixture.fileContentsByPath[filePath];
              if (fixtureContent === undefined) {
                return { status: 'not-found' };
              }
              return { content: Buffer.from(fixtureContent), status: 'ok' };
            }
            const content = await fileSystem.readFile({
              kind: 'file',
              name: path.basename(filePath),
              path: filePath,
              platform: 'electron',
            });
            return { content: Buffer.from(content), status: 'ok' };
          },
        };
      }
      const root = workspaceRootRegistryFileSystemSeams
        ? await workspaceRootRegistryFileSystemSeams.createSecureRoot(rootPath)
        : await (async (): Promise<SecureWorkspaceRoot> => {
            const { SecureRoot } = await import('@brainstrike/secure-fs-native');
            const secureRoot = new SecureRoot(rootPath);
            return {
              canonicalPath: secureRoot.canonicalPath,
              close: () => secureRoot.close(),
              listDir: (relativePath, maxEntries) =>
                secureRoot.listDirAsync(relativePath, maxEntries),
              readFile: (relativePath, maxBytes) =>
                secureRoot.readFileAsync(relativePath, maxBytes),
            };
          })();
      try {
        bindSyntheticFileSystemClassification(root.canonicalPath, false);
      } catch (error) {
        root.close();
        throw error;
      }
      return root;
    },
    disposeCommandSessionsForRoot,
    evictLspServersForRoot: evictLspServerForRoot,
    getRootsCatalog,
    // ADR-0015: the catalog refuses once the app quits during a reset; that is expected.
    isExpectedCatalogRefusal: isExpectedShutdownRefusal,
    onRootGranted: notifyRootGranted,
    pathExists: (rootPath) => ipcPathExists(fileSystem, rootPath),
    resolveCanonicalRoot: async (rootPath) => {
      if (usesSyntheticFileSystem(rootPath)) {
        return path.normalize(rootPath);
      }
      const canonicalRoot = path.normalize(await realpath(rootPath));
      bindSyntheticFileSystemClassification(canonicalRoot, false);
      return canonicalRoot;
    },
    resolveReadPath: async (requestedPath, canonicalRoot) => {
      if (!usesSyntheticFileSystem(canonicalRoot)) {
        if (workspaceRootRegistryFileSystemSeams) {
          return workspaceRootRegistryFileSystemSeams.resolveReadPath(requestedPath, canonicalRoot);
        }
        const result = await resolveValidatedPath({
          allowMissing: false,
          maxTraversal: 0,
          requestedPath,
          rootDir: canonicalRoot,
        });
        if (!result.ok) {
          throw new AccessError(
            `Path validation failed: ${result.error.message}`,
            requestedPath,
            'read'
          );
        }
        return result.path;
      }
      const candidate = path.isAbsolute(requestedPath)
        ? path.normalize(requestedPath)
        : path.resolve(canonicalRoot, requestedPath);
      const relative = path.relative(canonicalRoot, candidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw refusalError(
          'authorization',
          'workspace.path-outside-root',
          'Path is outside the selected workspace root.',
          'Choose a file inside the selected folder.'
        );
      }
      return candidate;
    },
    storage,
  });
  roots.setManagedWorktreeAuthorizer(managedWorktreeAuthorizer ?? null);

  const addSelectedRoot = async (): Promise<RootDescriptor> =>
    roots.addRoot(await resolveRequestedDirectoryHandle(fileSystem));

  registerDomain(registry, 'files', fileSystemContract, {
    addRoot: async () =>
      settleFileSystemResult({ category: 'files', code: 'files.add-root-failed' }, async () =>
        addSelectedRoot()
      ),

    // Picker-less: main's recent-roots ledger is the only authorization, so an
    // unrecorded path is rejected there rather than granted from a renderer
    // string. The shape check stays here so a malformed payload never reaches it.
    // The grant-notification callback (recents pushed to OS recent-documents +
    // File-menu rebuild) fires structurally from inside WorkspaceRootRegistry.addRoot,
    // gated on the SAME recordInRecentRoots flag that decides ledger recording —
    // see onRootGranted on the `roots` construction above — so this handler
    // does not need to call it itself.
    addRootByPath: async (requestedPath: string) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.add-root-by-path-failed' },
        async () => {
          if (requestedPath.length === 0) {
            throw refusalError(
              'input',
              'workspace.path-invalid',
              'The folder path is empty.',
              'Choose a folder.'
            );
          }
          return roots.addRootByPath(requestedPath);
        }
      ),

    deleteRootData: async (rootId: string) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.delete-root-data-failed' },
        async () => {
          if (!onDeleteRootData) {
            throw new Error('The main-owned root data deletion capability is unavailable.');
          }
          await onDeleteRootData(rootId);
        }
      ),

    exists: async (requestedPath: string) =>
      settleFileSystemResult({ category: 'files', code: 'files.exists-failed' }, async () =>
        ipcPathExists(fileSystem, requestedPath)
      ),

    listRecentRoots: async () =>
      settleFileSystemResult(
        { category: 'files', code: 'files.list-recent-roots-failed' },
        async () => roots.listRecentRoots()
      ),

    readDirectory: async (handle: DirectoryHandle) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.read-directory-failed' },
        async () => {
          const fixture = getElectronE2eFileSystemFixture();
          if (fixture && usesSyntheticFileSystem(fixture.rootHandle.path)) {
            fixture.readDirectoryCalls.push(handle.path);
            await waitForFixtureDirectoryReadDelay(resolveFixtureDirectoryReadDelayMs(fixture));
            const entries = fixture.directoriesByPath[handle.path];
            if (!entries) {
              throw new AccessError(
                `Failed to read directory: no E2E fixture registered for ${handle.path}`,
                handle.path,
                'read'
              );
            }
            return entries as unknown as IFileNode[];
          }

          if (isMockFileSystemIpcPath(handle.path) && usesSyntheticFileSystem(MOCK_ROOT_PATH)) {
            return getTestDirectoryStructure(MOCK_ROOT_PATH) as unknown as IFileNode[];
          }
          return roots.readDirectory(await resolveDirectoryHandle(handle));
        }
      ),

    readFile: async (handle: FileHandle) =>
      settleFileSystemResult({ category: 'files', code: 'files.read-file-failed' }, async () => {
        const fixture = getElectronE2eFileSystemFixture();
        if (fixture && usesSyntheticFileSystem(fixture.rootHandle.path)) {
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

        if (isMockFileSystemIpcPath(handle.path) && usesSyntheticFileSystem(MOCK_ROOT_PATH)) {
          return 'Mock file content for testing purposes\nThis is a test file.\n';
        }
        try {
          const resolvedHandle = await resolveFileHandle(handle);
          return await roots.readFile(resolvedHandle);
        } catch (error) {
          const payload = toFileReadErrorPayload(error, handle?.path ?? '');
          if (payload) {
            return payload;
          }
          throw error;
        }
      }),

    readFileByAbsolutePath: async (
      absolutePath: unknown,
      claimedRootPath: unknown,
      claimedRootId: unknown
    ) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.read-file-by-absolute-path-failed' },
        async () => {
          const diagnosticPath = typeof absolutePath === 'string' ? absolutePath : '';
          try {
            return await roots.readFileByAbsolutePath(absolutePath, claimedRootPath, claimedRootId);
          } catch (error) {
            const payload = toFileReadErrorPayload(error, diagnosticPath);
            if (payload) {
              return payload;
            }
            throw error;
          }
        }
      ),

    readFileByPath: async (absolutePath: string) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.read-file-by-path-failed' },
        async () => {
          const fixture = getElectronE2eFileSystemFixture();
          if (fixture && usesSyntheticFileSystem(fixture.rootHandle.path)) {
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

          if (
            absolutePath.startsWith(MOCK_PATH_PREFIX) &&
            usesSyntheticFileSystem(MOCK_ROOT_PATH)
          ) {
            return 'Mock file content for testing purposes\nThis is a test file.\n';
          }

          try {
            return await roots.readFile(absolutePath);
          } catch (error) {
            const payload = toFileReadErrorPayload(error, absolutePath);
            if (payload) {
              return payload;
            }
            throw error;
          }
        }
      ),
    removeRoot: async (rootId: string) =>
      settleFileSystemResult({ category: 'files', code: 'files.remove-root-failed' }, async () =>
        roots.removeRoot(rootId)
      ),
    requestDirectoryAccess: async () =>
      settleFileSystemResult(
        { category: 'files', code: 'files.request-directory-access-failed' },
        async () => (await addSelectedRoot()).handle
      ),

    restoreLastFolder: async () =>
      settleFileSystemResult(
        { category: 'files', code: 'files.restore-last-folder-failed' },
        async () => roots.restoreLastFolder()
      ),

    restoreRoots: async () =>
      settleFileSystemResult({ category: 'files', code: 'files.restore-roots-failed' }, async () =>
        roots.restoreRoots()
      ),

    saveLastFolder: async (folderPath: string) =>
      settleFileSystemResult(
        { category: 'files', code: 'files.save-last-folder-failed' },
        async () => roots.setLastFolder(folderPath)
      ),
  });
  return {
    close: async (): Promise<void> => {
      const results = await Promise.allSettled(
        [() => registry.unregisterAll(), () => roots.dispose()].map(async (retire) => retire())
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Filesystem IPC owners did not retire.');
      }
      syntheticFileSystemClassifications.clear();
    },
    roots,
    unregister: () => registry.unregisterAll(),
  };
}
