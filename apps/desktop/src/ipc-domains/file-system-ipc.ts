import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  isStateStoreReadOnly,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ManagedWorktreeAuthorizer } from '@brainstrike/assistant-service/node-workspace-services';
import {
  createNativeSecureRoot,
  isWorkspaceRootRegistryDisposed,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RootDescriptor } from '@brainstrike/types';
import { ipcMain } from 'electron';
import {
  disposeHostCommandSessionsForRoot,
  evictHostLspServersForRoot,
} from '../agent-host-platform/host-root-cleanup-client';
import { isDesktopShuttingDown, isExpectedShutdownRefusal } from '../desktop-shutdown-state';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../platform/desktop-ipc-registry';
import { fileSystemContract } from './file-system.contract';
import { fileSystemArgs } from './file-system-args';
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
  /**
   * Fired after a removal retired a mounted folder, or failed once it may have: main re-reads
   * the committed folders through its native index transition, as a registration does.
   */
  readonly onWorkspaceRootsChanged?: (() => void) | undefined;
  readonly storage: ElectronStorageAdapter;
  /** Resolves once the catalog's profile is open; a factory reset holds it until it reopens. */
  readonly whenRootsCatalogOpen?: () => Promise<void>;
  /** Explicit constructor seams for unit tests of native-root composition. */
  readonly workspaceRootRegistryFileSystemSeams?: WorkspaceRootRegistryFileSystemSeams;
}

const E2E_REAL_ROOT_PATH_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH' as const;
const logger = createLogger('FileSystemIpc');

/**
 * BST-2118: a disposed workspace root registry refuses with a typed refusal, which
 * crosses IPC unlogged. The app's own shutdown is its only disposer, so a refusal
 * while quitting is expected (info, ADR-0015); at any other time it is an error.
 */
function settleFileSystemResult<T>(
  failure: { readonly category: string; readonly code: string },
  run: () => T | Promise<T>
): Promise<BoundaryResult<T>> {
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
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
}

/** Validates the E2E harness's real root path the test-mode folder picker opens. */
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
 * the OS dialog cannot open, so the picker answers the real disposable folder
 * the E2E harness names in BRAINSTRIKE_E2E_REAL_ROOT_PATH, and refuses when it
 * names none. Shared by fs:requestDirectoryAccess and fs:addRoot so both pick
 * flows follow the exact same test-mode contract.
 */
async function resolveRequestedDirectoryHandle(
  fileSystem: ElectronFileSystemAdapter
): Promise<DirectoryHandle> {
  if (isE2eTestMode()) {
    const realRootHandle = await resolveE2eRealRootDirectoryHandle(fileSystem);
    if (!realRootHandle) {
      throw new Error(
        `Test mode's folder picker opens the folder ${E2E_REAL_ROOT_PATH_ENV} names, and it names none.`
      );
    }
    return realRootHandle;
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

/** Existence check for stored-root pruning (fs:restoreRoots). */
async function storedRootExists(
  fileSystem: ElectronFileSystemAdapter,
  requestedPath: string
): Promise<boolean> {
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

export interface FileSystemIpcDomain {
  close(): Promise<void>;
  readonly roots: WorkspaceRootRegistry;
  unregister(): void;
}

/** @internal Filesystem IPC regressions drive registration and disposal directly. */
export function registerFileSystemIpcHandlers(
  options: RegisterFileSystemIpcHandlersOptions
): () => Promise<void> {
  return createFileSystemIpcDomain(options).close;
}

export function createFileSystemIpcDomain({
  disposeCommandSessionsForRoot = disposeHostCommandSessionsForRoot,
  evictLspServersForRoot = evictHostLspServersForRoot,
  fileSystem,
  getRootsCatalog,
  whenRootsCatalogOpen,
  managedWorktreeAuthorizer,
  onWorkspaceRootGranted,
  onWorkspaceRootsChanged,
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
  const registry = createDesktopIpcRegistry({ ipcMain });
  const roots = new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath): Promise<SecureWorkspaceRoot> =>
      workspaceRootRegistryFileSystemSeams
        ? await workspaceRootRegistryFileSystemSeams.createSecureRoot(rootPath)
        : await createNativeSecureRoot(rootPath),
    disposeCommandSessionsForRoot,
    evictLspServersForRoot,
    getRootsCatalog,
    // ADR-0015: the catalog refuses once the app quits during a reset; that is
    // expected. So is a damaged store, which opened read-only (BST-2144).
    isExpectedCatalogRefusal: (error) =>
      isExpectedShutdownRefusal(error) || isStateStoreReadOnly(error),
    ...(whenRootsCatalogOpen ? { whenCatalogOpen: whenRootsCatalogOpen } : {}),
    onRestoredRootsChanged: onWorkspaceRootsChanged,
    onRootGranted: notifyRootGranted,
    pathExists: (rootPath) => storedRootExists(fileSystem, rootPath),
    resolveReadPath: async (requestedPath, canonicalRoot) => {
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
    },
    storage,
  });
  roots.setManagedWorktreeAuthorizer(managedWorktreeAuthorizer ?? null);

  const addSelectedRoot = async (): Promise<RootDescriptor> =>
    roots.addRoot(await resolveRequestedDirectoryHandle(fileSystem));

  registerDomain(registry, 'files', fileSystemContract, fileSystemArgs, {
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

    listRecentRoots: async () =>
      settleFileSystemResult(
        { category: 'files', code: 'files.list-recent-roots-failed' },
        async () => roots.listRecentRoots()
      ),

    removeRoot: async (rootId: string) =>
      settleFileSystemResult({ category: 'files', code: 'files.remove-root-failed' }, async () => {
        // Removing a mounted folder ends the index's borrow of it, even when the removal then
        // fails: Main re-reads the folders either way.
        const retired = await roots.removeRoot(rootId).catch((error: unknown) => {
          onWorkspaceRootsChanged?.();
          throw error;
        });
        if (retired) {
          onWorkspaceRootsChanged?.();
        }
      }),
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
    },
    roots,
    unregister: () => registry.unregisterAll(),
  };
}
