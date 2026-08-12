import path from 'node:path';
import type { DirectoryHandle, FileHandle, SerializableFileNode } from '@brainstrike/file-system';
import {
  AccessError,
  getFileTooLargeMessage,
  getTestDirectoryStructure,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RootDescriptor } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { disposeDesktopCommandSessionsForRoot } from '../assistant-server/command-session-manager';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import {
  markRootDisconnectedByPath,
  markRootsDisconnectedExcept,
  reconnectWorkspaceRootForProcess,
  revokeWorkspaceRootForProcess,
  type WorkspaceRootsQueryable,
} from '../assistant-server/workspace-roots';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_NOT_FOUND,
  type FileReadErrorPayload,
  isFileNotFoundError,
} from '../file-read-errors';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { mountLastFolderCapability } from './last-folder-capability';
import {
  createWorkspaceFileCapabilities,
  type WorkspaceFileCapabilities,
} from './workspace-file-capabilities';

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
  readonly getRootsDatabase: () => Promise<WorkspaceRootsQueryable>;
  readonly storage: ElectronStorageAdapter;
  readonly workspaceFileCapabilities?: WorkspaceFileCapabilities;
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

interface RootsListReadResult {
  readonly entries: StoredRootEntry[];
  /** True when a stored value existed but could not be fully understood. */
  readonly malformed: boolean;
}

async function readRootsListResult(storage: ElectronStorageAdapter): Promise<RootsListReadResult> {
  const raw = await storage.getItem(ROOTS_LIST_STORAGE_KEY);
  if (!raw) {
    return { entries: [], malformed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('Failed to parse rootsList — treating as empty', { error });
    return { entries: [], malformed: true };
  }

  if (!Array.isArray(parsed)) {
    logger.warn('rootsList storage value is not an array', { key: ROOTS_LIST_STORAGE_KEY });
    return { entries: [], malformed: true };
  }
  const valid = parsed.filter(isStoredRootEntry);
  if (valid.length !== parsed.length) {
    logger.warn('rootsList contained malformed entries', {
      total: parsed.length,
      valid: valid.length,
    });
    return { entries: valid, malformed: true };
  }
  return { entries: valid, malformed: false };
}

async function readRootsList(storage: ElectronStorageAdapter): Promise<StoredRootEntry[]> {
  return (await readRootsListResult(storage)).entries;
}

async function writeRootsList(
  storage: ElectronStorageAdapter,
  entries: StoredRootEntry[]
): Promise<void> {
  await storage.setItem(ROOTS_LIST_STORAGE_KEY, JSON.stringify(entries));
}

function rewriteCanonicalRootEntry(
  entries: readonly StoredRootEntry[],
  resolvedPath: string,
  canonicalEntry: StoredRootEntry
): StoredRootEntry[] | null {
  const updatedEntries: StoredRootEntry[] = [];
  let inserted = false;
  for (const candidate of entries) {
    if (candidate.rootId === canonicalEntry.rootId) {
      if (!inserted) {
        updatedEntries.push(canonicalEntry);
        inserted = true;
      }
    } else if (candidate.path !== resolvedPath && candidate.path !== canonicalEntry.path) {
      updatedEntries.push(candidate);
    }
  }
  if (!inserted) {
    updatedEntries.push(canonicalEntry);
  }
  const changed =
    updatedEntries.length !== entries.length ||
    updatedEntries.some(
      (candidate, index) =>
        candidate.path !== entries[index]?.path || candidate.rootId !== entries[index]?.rootId
    );
  return changed ? updatedEntries : null;
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
  await resolveFileSystemIpcPath(handle?.path, 'directory handle');
  return handle;
}

async function resolveFileHandle(handle: FileHandle): Promise<FileHandle> {
  await resolveFileSystemIpcPath(handle?.path, 'file handle');
  return handle;
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
  disposeCommandSessionsForRoot = disposeDesktopCommandSessionsForRoot,
  evictLspServersForRoot: evictLspServersForRootOverride,
  fileSystem,
  getRootsDatabase,
  storage,
  workspaceFileCapabilities = createWorkspaceFileCapabilities(),
}: RegisterFileSystemIpcHandlersOptions): () => void {
  const evictLspServerForRoot = evictLspServersForRootOverride ?? evictLspServersForRoot;
  const registry = createDesktopIpcRegistry({ ipcMain });
  const sessionOnlyRootIds = new Set<string>();
  const sessionRevokedRootIds = new Set<string>();
  let rootMutationQueue = Promise.resolve();
  const runSerializedRootMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = rootMutationQueue;
    let release = (): void => undefined;
    rootMutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const mountWorkspaceRoot = async (entry: StoredRootEntry): Promise<string> => {
    if (isMockFileSystemIpcPath(entry.path)) {
      return path.normalize(entry.path);
    }
    return await workspaceFileCapabilities.mountRoot(entry);
  };
  const mountWorkspaceRootIfNeeded = async (
    entry: StoredRootEntry
  ): Promise<{ canonicalPath: string; newlyMounted: boolean }> => {
    const existingMount = workspaceFileCapabilities.getMountedRoot?.(entry.rootId);
    if (existingMount) {
      return { canonicalPath: existingMount.path, newlyMounted: false };
    }
    return { canonicalPath: await mountWorkspaceRoot(entry), newlyMounted: true };
  };
  const revokeRootForSession = (rootId: string): void => {
    sessionOnlyRootIds.delete(rootId);
    sessionRevokedRootIds.add(rootId);
    workspaceFileCapabilities.unmountRoot(rootId);
  };
  const cleanupRootResources = async (rootIds: readonly string[]): Promise<void> => {
    await Promise.all(
      rootIds.map(async (rootId) => {
        await Promise.all([
          evictLspServerForRoot(rootId).catch((error: unknown) => {
            logger.debug('removeRoot: LSP server eviction failed (non-fatal)', { error, rootId });
          }),
          disposeCommandSessionsForRoot(rootId).catch((error: unknown) => {
            logger.warn('removeRoot: command session disposal failed', { error, rootId });
          }),
        ]);
      })
    );
  };
  const resolveLastFolderForSave = async (folderPath: string): Promise<string | null> => {
    try {
      return await resolveFileSystemIpcPath(folderPath, 'last folder');
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Failed to save last folder', { error });
      }
      return null;
    }
  };
  const performSaveLastFolder = async (folderPath: string): Promise<void> => {
    const resolvedPath = await resolveLastFolderForSave(folderPath);
    if (resolvedPath === null) {
      return;
    }
    const entries = await readRootsList(storage);
    const existing = entries.find((entry) => entry.path === resolvedPath);
    const initialEntry =
      existing ??
      ({
        addedAt: Date.now(),
        path: resolvedPath,
        rootId: crypto.randomUUID(),
      } satisfies StoredRootEntry);
    const newlyMountedRootIds = new Set<string>();
    try {
      const mounted = await mountLastFolderCapability({
        entries,
        existing,
        initialEntry,
        mountIfNeeded: mountWorkspaceRootIfNeeded,
        newlyMountedRootIds,
        unmountRoot: workspaceFileCapabilities.unmountRoot,
      });
      await storage.setItem(LAST_FOLDER_STORAGE_KEY, mounted.canonicalPath);
      const canonicalEntry: StoredRootEntry = {
        ...mounted.entry,
        path: mounted.canonicalPath,
      };
      const updatedEntries = rewriteCanonicalRootEntry(entries, resolvedPath, canonicalEntry);
      if (updatedEntries) {
        await writeRootsList(storage, updatedEntries);
      }
      if (mounted.supersededPreexistingRootId) {
        workspaceFileCapabilities.unmountRoot(mounted.supersededPreexistingRootId);
      }
      sessionRevokedRootIds.delete(mounted.entry.rootId);
      reconnectWorkspaceRootForProcess(mounted.entry.rootId, mounted.canonicalPath);
    } catch (error) {
      for (const rootId of newlyMountedRootIds) {
        workspaceFileCapabilities.unmountRoot(rootId);
      }
      throw error;
    }
  };

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
        await waitForFixtureDirectoryReadDelay(resolveFixtureDirectoryReadDelayMs(fixture));
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
      return workspaceFileCapabilities.readDirectory(await resolveDirectoryHandle(handle));
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
        return await workspaceFileCapabilities.readFile(resolvedHandle);
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
        return await workspaceFileCapabilities.readFile(absolutePath);
      } catch (error) {
        const payload = toFileReadErrorPayload(error, absolutePath);
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

    const entries = await readRootsList(storage);
    const entry = entries.find((candidate) => candidate.path === resolvedPath);
    if (!entry) {
      throw new Error('Stored last folder is not registered as a workspace root.');
    }
    return runSerializedRootMutation(async () => {
      if (sessionRevokedRootIds.has(entry.rootId)) {
        return null;
      }
      const canonicalPath = await mountWorkspaceRoot(entry);
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(canonicalPath),
        path: canonicalPath,
        platform: 'electron',
        rootId: entry.rootId,
      };
      return handle;
    });
  });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.saveLastFolder,
    async (_event, folderPath: string) =>
      runSerializedRootMutation(() => performSaveLastFolder(folderPath))
  );

  /**
   * Converge DB roots status on the just-restored mount set. rootsList is the
   * authoritative record of which folders the Explorer shows, so any 'live' row
   * outside it is a leak (see markRootsDisconnectedExcept for how they arise).
   *
   * Deliberately NOT fail-closed, unlike the fs:removeRoot transition: this runs
   * on the boot path, and rejecting the restore because the DB is briefly
   * unavailable would leave the app with no roots at all — strictly worse than a
   * stale row. The failure is logged at ERROR (never silent) and the next boot
   * retries. fs:removeRoot remains the fail-closed primary; this is convergence.
   */
  const convergeRootStatuses = async (restoredPaths: readonly string[]): Promise<void> => {
    try {
      const rootsDatabase = await getRootsDatabase();
      // Re-read rootsList HERE rather than reusing the entries this handler
      // opened with. addRoot and restoreRoots serialize their mutations, but
      // this defensive read keeps DB convergence tied to the durable current
      // list if another future writer is introduced. Over-inclusion is the safe
      // direction: at worst a genuinely stale row survives to the next boot,
      // whereas under-inclusion would silently drop a just-mounted root.
      const current = await readRootsListResult(storage);
      if (current.malformed) {
        // NO SILENT FALLBACKS: `readRootsList` coerces an unreadable store to
        // [], which is fine for the RESTORE (it just mounts nothing) but must
        // never reach convergence — an empty mount set demotes every live root,
        // so a corrupt storage value would silently disconnect the whole
        // workspace. A degraded read is "mount set UNKNOWN", not "authoritative
        // zero". Skip, surface at ERROR, and let the next boot converge once the
        // store parses again.
        logger.error(
          'restoreRoots: rootsList is unreadable; skipping root-status convergence rather than demoting every live root',
          { key: ROOTS_LIST_STORAGE_KEY }
        );
        return;
      }
      const mountedPaths = [
        ...new Set([...restoredPaths, ...current.entries.map((entry) => entry.path)]),
      ];
      const demoted = await markRootsDisconnectedExcept(rootsDatabase, mountedPaths);
      if (demoted.length > 0) {
        logger.warn('restoreRoots: disconnected DB roots that are no longer mounted', {
          paths: demoted.map((row) => row.path),
        });
      }
    } catch (error) {
      logger.error(
        'restoreRoots: failed to converge DB root statuses; stale roots may remain live',
        {
          error,
        }
      );
    }
  };

  const restoreStoredRootEntry = async (
    entry: StoredRootEntry
  ): Promise<{
    canonicalPath: string;
    descriptor: RootDescriptor;
    newlyMounted: boolean;
    storedEntry: StoredRootEntry;
  } | null> => {
    if (sessionRevokedRootIds.has(entry.rootId)) {
      return null;
    }
    let exists: boolean;
    try {
      const resolvedPath = await resolveFileSystemIpcPath(entry.path, 'stored root');
      exists = await ipcPathExists(fileSystem, resolvedPath);
    } catch (error) {
      logger.debug('Skipping invalid root entry during restore', { error, path: entry.path });
      return null;
    }
    if (!exists) {
      logger.debug('Pruning stale root from rootsList', { path: entry.path });
      return null;
    }

    const { canonicalPath, newlyMounted } = await mountWorkspaceRootIfNeeded(entry);
    const basename = path.basename(canonicalPath);
    return {
      canonicalPath,
      descriptor: {
        displayName: basename,
        handle: {
          kind: 'directory',
          name: basename,
          path: canonicalPath,
          platform: 'electron',
          rootId: entry.rootId,
        },
        kind: 'path',
        permissionState: 'granted',
        persisted: true,
        rootId: entry.rootId,
      },
      newlyMounted,
      storedEntry: { ...entry, path: canonicalPath },
    };
  };

  type RestoredRootEntry = Awaited<ReturnType<typeof restoreStoredRootEntry>>;

  const rollbackRestoredRoots = (
    restoreResults: readonly PromiseSettledResult<RestoredRootEntry>[]
  ): void => {
    for (const result of restoreResults) {
      if (result.status === 'fulfilled' && result.value?.newlyMounted) {
        workspaceFileCapabilities.unmountRoot(result.value.storedEntry.rootId);
      }
    }
  };

  const collectRestoredRoots = (
    restoreResults: readonly PromiseSettledResult<RestoredRootEntry>[]
  ): {
    descriptors: RootDescriptor[];
    newlyMountedRootIds: Set<string>;
    survivors: StoredRootEntry[];
  } => {
    const survivors: StoredRootEntry[] = [];
    const descriptors: RootDescriptor[] = [];
    const canonicalRootIds = new Map<string, string>();
    const newlyMountedRootIds = new Set<string>();
    for (const result of restoreResults) {
      const restored = result.status === 'fulfilled' ? result.value : null;
      if (!restored) {
        continue;
      }
      const restoredRootId = restored.storedEntry.rootId;
      const retainedRootId = canonicalRootIds.get(restored.canonicalPath);
      if (retainedRootId) {
        if (retainedRootId !== restoredRootId) {
          workspaceFileCapabilities.unmountRoot(restoredRootId);
        }
        logger.warn('restoreRoots: discarded duplicate canonical root', { rootId: restoredRootId });
        continue;
      }
      canonicalRootIds.set(restored.canonicalPath, restoredRootId);
      if (restored.newlyMounted) {
        newlyMountedRootIds.add(restoredRootId);
      }
      survivors.push(restored.storedEntry);
      descriptors.push(restored.descriptor);
    }
    return { descriptors, newlyMountedRootIds, survivors };
  };

  const performRestoreRoots = async (): Promise<RootDescriptor[]> => {
    const { entries, malformed } = await readRootsListResult(storage);
    if (entries.length === 0) {
      workspaceFileCapabilities.retainRoots(new Set(sessionOnlyRootIds));
      await convergeRootStatuses([]);
      return [];
    }
    const rootIdentities = new Set(
      entries.map(({ path: rootPath, rootId }) => `${rootId}\0${rootPath}`)
    );
    if (rootIdentities.size !== new Set(entries.map(({ rootId }) => rootId)).size) {
      throw new Error('rootsList maps one root ID to multiple paths.');
    }

    const restoreResults = await Promise.allSettled(entries.map(restoreStoredRootEntry));
    const rejected = restoreResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) {
      rollbackRestoredRoots(restoreResults);
      throw rejected.reason;
    }
    const { descriptors, newlyMountedRootIds, survivors } = collectRestoredRoots(restoreResults);
    const rootsChanged =
      survivors.length !== entries.length ||
      survivors.some((entry, index) => entry.path !== entries[index]?.path);
    try {
      if (rootsChanged && !malformed) {
        await writeRootsList(storage, survivors);
      }
    } catch (error) {
      for (const rootId of newlyMountedRootIds) {
        workspaceFileCapabilities.unmountRoot(rootId);
      }
      throw error;
    }
    const retainedRootIds = new Set(sessionOnlyRootIds);
    for (const survivor of survivors) {
      retainedRootIds.add(survivor.rootId);
    }
    workspaceFileCapabilities.retainRoots(retainedRootIds);
    await convergeRootStatuses(descriptors.map((descriptor) => descriptor.handle.path));
    return descriptors;
  };

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.restoreRoots, async () =>
    runSerializedRootMutation(performRestoreRoots)
  );

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.addRoot, async () =>
    runSerializedRootMutation(async () => {
      // Test-mode aware (same contract as fs:requestDirectoryAccess): the real
      // adapter stats the picked path, which ENOENTs on e2e mock paths.
      const [handle, entries] = await Promise.all([
        resolveRequestedDirectoryHandle(fileSystem),
        readRootsList(storage),
      ]);
      const resolvedPath = await resolveFileSystemIpcPath(handle.path, 'added root');
      // Upsert into rootsList keyed by resolved path.
      // restoreRoots runs on boot and can otherwise interleave at any await. Both
      // mutations share the queue so stale restore snapshots cannot unmount or
      // overwrite a root that addRoot has just persisted.
      let existing = entries.find((entry) => entry.path === resolvedPath);
      let rootId = existing?.rootId ?? crypto.randomUUID();
      let persisted = true;

      let canonicalPath = await mountWorkspaceRoot({
        addedAt: Date.now(),
        path: resolvedPath,
        rootId,
      });
      const canonicalExisting = existing ?? entries.find((entry) => entry.path === canonicalPath);
      if (canonicalExisting && canonicalExisting.rootId !== rootId) {
        workspaceFileCapabilities.unmountRoot(rootId);
        rootId = canonicalExisting.rootId;
        canonicalPath = await mountWorkspaceRoot({
          addedAt: Date.now(),
          path: canonicalPath,
          rootId,
        });
      }
      existing = canonicalExisting;
      const basename = path.basename(canonicalPath);
      sessionRevokedRootIds.delete(rootId);

      if (existing) {
        const updated: StoredRootEntry[] = entries.map((e) =>
          e.rootId === rootId ? { ...e, addedAt: Date.now(), path: canonicalPath } : e
        );
        try {
          await writeRootsList(storage, updated);
          sessionOnlyRootIds.delete(rootId);
        } catch (error) {
          // The root is ALREADY durably stored — a failed addedAt bump does not
          // change that. Per the RootDescriptor.persisted contract, persisted
          // stays true: reporting false here would make callers skip DB
          // registration for a perfectly durable root.
          logger.warn('addRoot: failed to bump addedAt on existing rootsList entry', { error });
        }
      } else {
        const newEntry: StoredRootEntry = { addedAt: Date.now(), path: canonicalPath, rootId };
        try {
          await writeRootsList(storage, [...entries, newEntry]);
          sessionOnlyRootIds.delete(rootId);
        } catch (error) {
          logger.warn('addRoot: failed to write rootsList', { error });
          persisted = false;
          sessionOnlyRootIds.add(rootId);
        }
      }

      // Shim parity: keep writing lastFolderPath
      try {
        await storage.setItem(LAST_FOLDER_STORAGE_KEY, canonicalPath);
      } catch (error) {
        logger.warn('addRoot: failed to write lastFolderPath', { error });
      }
      reconnectWorkspaceRootForProcess(rootId, canonicalPath);

      const descriptor: RootDescriptor = {
        displayName: basename,
        handle: {
          kind: 'directory',
          name: basename,
          path: canonicalPath,
          platform: 'electron',
          rootId,
        },
        kind: 'path',
        permissionState: 'granted',
        persisted,
        rootId,
      };
      return descriptor;
    })
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.removeRoot,
    async (_event, rootId: string) =>
      runSerializedRootMutation(async () => {
        // Disconnect ≠ delete: this forgets the stored rootsList entry (and a
        // matching lastFolderPath) and transitions the DB roots row to
        // status='disconnected'. It never DELETEs — all roots/file_records/
        // file_chunks rows are deliberately KEPT, and reconcileRoots restores
        // status='live' on re-add, so remounting the same folder reuses its
        // rootId and resumes without re-indexing.
        const entries = await readRootsList(storage);
        const removed = entries.find((entry) => entry.rootId === rootId);
        if (!removed) {
          if (sessionOnlyRootIds.has(rootId)) {
            revokeRootForSession(rootId);
            return;
          }
          logger.debug('removeRoot: rootId not found in rootsList — nothing to remove', { rootId });
          return;
        }

        // Status transition FIRST, fail-closed: if it throws, the invoke rejects
        // and the root stays fully mounted (rootsList untouched). The DB row is
        // keyed by path (unique idx_roots_path) — the adapter rootId can diverge
        // from roots.id for path-matched legacy rows. The inverse ordering
        // (rootsList written, then a failed UPDATE) would leave the assistant
        // server serving a folder the UI no longer shows.
        let disconnectedRootIds: readonly string[];
        try {
          const rootsDatabase = await getRootsDatabase();
          disconnectedRootIds = await markRootDisconnectedByPath(rootsDatabase, removed.path);
        } catch (error) {
          const revokedRootIds = revokeWorkspaceRootForProcess(rootId, removed.path);
          revokeRootForSession(rootId);
          await cleanupRootResources(revokedRootIds);
          throw error;
        }
        if (disconnectedRootIds.length === 0) {
          // A rootsList entry is a persisted root, so it SHOULD own a DB row. Zero
          // rows matched means the row's stored `path` diverged from this entry's
          // (normalization/case) or the row was never created — surface it (NO
          // SILENT FALLBACKS) instead of clearing rootsList while a possibly-live
          // row keeps being served to the assistant tools.
          logger.warn(
            'removeRoot: no roots row matched the disconnected path; DB status unchanged',
            {
              path: removed.path,
              rootId,
            }
          );
        }

        const remaining = entries.filter((entry) => entry.rootId !== rootId);
        try {
          await writeRootsList(storage, remaining);
        } catch (error) {
          revokeRootForSession(rootId);
          throw error;
        }
        revokeRootForSession(rootId);

        // Root-owned LSP servers and command sessions cannot survive disconnect.
        // Cleanup is best-effort because the durable DB + rootsList transition
        // has already committed by this point.
        await cleanupRootResources(disconnectedRootIds);

        // Keep the dual stores coherent: clear lastFolderPath only when it points
        // at the removed root's path.
        const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);
        if (lastFolderPath === removed.path) {
          await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
        }
      })
  );

  return () => {
    registry.unregisterAll();
    workspaceFileCapabilities.dispose();
  };
}
