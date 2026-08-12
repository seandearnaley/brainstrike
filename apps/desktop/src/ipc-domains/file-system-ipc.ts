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
  /**
   * True when a stored value EXISTED but could not be fully understood
   * (unparseable, wrong shape, or individual entries dropped) — i.e. `entries`
   * is a degraded guess, not the user's real mount list.
   *
   * An ABSENT or legitimately empty list is NOT malformed: that is an
   * authoritative "no folders open". The distinction matters because callers
   * that treat the list as authoritative (root-status convergence) would
   * otherwise turn a corrupt storage value into a destructive write.
   */
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
    logger.warn('rootsList storage value is not an array — treating as empty', {
      key: ROOTS_LIST_STORAGE_KEY,
    });
    return { entries: [], malformed: true };
  }
  const valid = parsed.filter(isStoredRootEntry);
  if (valid.length !== parsed.length) {
    logger.warn('rootsList contained malformed entries — discarding invalid items', {
      total: parsed.length,
      valid: valid.length,
    });
    // A dropped entry means the surviving list is a SUBSET of the real mount
    // set, which is just as unsafe to converge against as a total parse failure.
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
  const mountWorkspaceRoot = async (entry: StoredRootEntry): Promise<string> => {
    if (isMockFileSystemIpcPath(entry.path)) {
      return path.normalize(entry.path);
    }
    return await workspaceFileCapabilities.mountRoot(entry);
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
        return await workspaceFileCapabilities.readFile(resolved.path);
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

    const entries = await readRootsList(storage);
    const entry = entries.find((candidate) => candidate.path === resolvedPath);
    if (!entry) {
      throw new Error('Stored last folder is not registered as a workspace root.');
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

      const entries = await readRootsList(storage);
      const existing = entries.find((entry) => entry.path === resolvedPath);
      let entry =
        existing ??
        ({
          addedAt: Date.now(),
          path: resolvedPath,
          rootId: crypto.randomUUID(),
        } satisfies StoredRootEntry);
      let canonicalPath = await mountWorkspaceRoot(entry);
      const canonicalExisting =
        entries.find((candidate) => candidate.path === canonicalPath) ?? existing;
      if (canonicalExisting && canonicalExisting.rootId !== entry.rootId) {
        workspaceFileCapabilities.unmountRoot(entry.rootId);
        entry = canonicalExisting;
        canonicalPath = await mountWorkspaceRoot(entry);
      }
      await storage.setItem(LAST_FOLDER_STORAGE_KEY, canonicalPath);
      const canonicalEntry: StoredRootEntry = { ...entry, path: canonicalPath };
      const updatedEntries = rewriteCanonicalRootEntry(entries, resolvedPath, canonicalEntry);
      if (updatedEntries) {
        await writeRootsList(storage, updatedEntries);
      }
    }
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
      // opened with. restoreRoots awaits per-entry path resolution, so an
      // fs:addRoot CAN interleave mid-restore (boot is not user-gesture-driven,
      // unlike the handlers the addRoot no-mutex note covers). That add writes
      // its rootsList entry BEFORE returning, and the renderer's reconcileRoots
      // inserts the DB row only after the IPC resolves — so a live row can only
      // exist for a path already in this list. Reading it immediately before the
      // UPDATE therefore makes the mount set a strict SUPERSET of every path
      // that could own a live row. Over-inclusion is the safe direction: at
      // worst a genuinely stale row survives to the next boot, whereas
      // under-inclusion would silently drop a just-mounted root.
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

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.restoreRoots, async () => {
    const entries = await readRootsList(storage);
    if (entries.length === 0) {
      workspaceFileCapabilities.retainRoots(new Set());
      // Not an early return: zero mounted folders is exactly the state in which
      // every remaining 'live' row is stale and must be demoted.
      await convergeRootStatuses([]);
      return [];
    }

    const survivors: StoredRootEntry[] = [];
    const descriptors: RootDescriptor[] = [];
    const canonicalPaths = new Set<string>();

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
        const canonicalPath = await mountWorkspaceRoot(entry);
        if (canonicalPaths.has(canonicalPath)) {
          workspaceFileCapabilities.unmountRoot(entry.rootId);
          logger.warn('restoreRoots: discarded duplicate canonical workspace root', {
            path: canonicalPath,
            rootId: entry.rootId,
          });
          continue;
        }
        canonicalPaths.add(canonicalPath);
        const basename = path.basename(canonicalPath);
        const canonicalEntry = { ...entry, path: canonicalPath };
        survivors.push(canonicalEntry);
        descriptors.push({
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
        });
      } catch (error) {
        logger.debug('Skipping invalid root entry during restore', { error, path: entry.path });
      }
    }

    const rootsChanged =
      survivors.length !== entries.length ||
      survivors.some((entry, index) => entry.path !== entries[index]?.path);
    workspaceFileCapabilities.retainRoots(new Set(survivors.map((entry) => entry.rootId)));
    if (rootsChanged) {
      await writeRootsList(storage, survivors);
    }

    // Compare on the RESOLVED path: that is what addRoot/reconcileRoots store on
    // the DB row, whereas a rootsList entry may hold the unresolved form.
    await convergeRootStatuses(descriptors.map((descriptor) => descriptor.handle.path));

    return descriptors;
  });

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.addRoot, async () => {
    // Test-mode aware (same contract as fs:requestDirectoryAccess): the real
    // adapter stats the picked path, which ENOENTs on e2e mock paths.
    const [handle, entries] = await Promise.all([
      resolveRequestedDirectoryHandle(fileSystem),
      readRootsList(storage),
    ]);
    const resolvedPath = await resolveFileSystemIpcPath(handle.path, 'added root');
    // Upsert into rootsList keyed by resolved path.
    // No mutex: these handlers are user-gesture-driven (single dialog at a time).
    // Concurrent RMW is only possible across multiple renderer windows, which is
    // not yet a use case. Revisit if programmatic addRoot calls are introduced.
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
  });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.removeRoot,
    async (_event, rootId: string) => {
      // Disconnect ≠ delete: this forgets the stored rootsList entry (and a
      // matching lastFolderPath) and transitions the DB roots row to
      // status='disconnected'. It never DELETEs — all roots/file_records/
      // file_chunks rows are deliberately KEPT, and reconcileRoots restores
      // status='live' on re-add, so remounting the same folder reuses its
      // rootId and resumes without re-indexing.
      const entries = await readRootsList(storage);
      const removed = entries.find((entry) => entry.rootId === rootId);
      if (!removed) {
        if (sessionOnlyRootIds.delete(rootId)) {
          workspaceFileCapabilities.unmountRoot(rootId);
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
      const rootsDatabase = await getRootsDatabase();
      const disconnectedRootIds = await markRootDisconnectedByPath(rootsDatabase, removed.path);
      if (disconnectedRootIds.length === 0) {
        // A rootsList entry is a persisted root, so it SHOULD own a DB row. Zero
        // rows matched means the row's stored `path` diverged from this entry's
        // (normalization/case) or the row was never created — surface it (NO
        // SILENT FALLBACKS) instead of clearing rootsList while a possibly-live
        // row keeps being served to the assistant tools.
        logger.warn('removeRoot: no roots row matched the disconnected path; DB status unchanged', {
          path: removed.path,
          rootId,
        });
      }

      const remaining = entries.filter((entry) => entry.rootId !== rootId);
      await writeRootsList(storage, remaining);
      sessionOnlyRootIds.delete(rootId);
      workspaceFileCapabilities.unmountRoot(rootId);

      // Tear down any pooled LSP language server for this root (report R2): the
      // folder is leaving the workspace, so its server child process must not
      // linger. Non-fatal — a stray server would otherwise idle until quit.
      await Promise.all(
        disconnectedRootIds.map(async (disconnectedRootId) => {
          await evictLspServerForRoot(disconnectedRootId).catch((error: unknown) => {
            logger.debug('removeRoot: LSP server eviction failed (non-fatal)', {
              error,
              rootId: disconnectedRootId,
            });
          });
        })
      );

      // A command session is owned by the workspace root, not by a renderer.
      // Disconnecting that root therefore ends and forgets every session before
      // the UI can move on. Failure is visible, but does not roll back the DB +
      // rootsList transition that has already committed.
      await Promise.all(
        disconnectedRootIds.map(async (disconnectedRootId) => {
          await disposeCommandSessionsForRoot(disconnectedRootId).catch((error: unknown) => {
            logger.warn('removeRoot: command session disposal failed', {
              error,
              rootId: disconnectedRootId,
            });
          });
        })
      );

      // Keep the dual stores coherent: clear lastFolderPath only when it points
      // at the removed root's path.
      const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);
      if (lastFolderPath === removed.path) {
        await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
      }
    }
  );

  return () => {
    registry.unregisterAll();
    workspaceFileCapabilities.dispose();
  };
}
