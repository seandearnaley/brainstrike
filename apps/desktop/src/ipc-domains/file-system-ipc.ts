import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  AccessError,
  DialogError,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { ipcMain } from 'electron';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../platform/desktop-ipc-registry';
import { fileSystemContract } from './file-system.contract';
import { fileSystemArgs } from './file-system-args';

const E2E_REAL_ROOT_PATH_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH' as const;

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
}

function isE2eTestMode(): boolean {
  return (
    process.argv.includes('--test-mode') ||
    process.env['ELECTRON_IS_E2E_TEST'] === 'true' ||
    process.env['NODE_ENV'] === 'test'
  );
}

/** Test mode's picker answers the real disposable folder the E2E harness names. */
async function resolveE2ePickedFolder(fileSystem: ElectronFileSystemAdapter): Promise<string> {
  const configuredPath = process.env[E2E_REAL_ROOT_PATH_ENV]?.trim();
  if (!configuredPath) {
    throw new Error(
      `Test mode's folder picker opens the folder ${E2E_REAL_ROOT_PATH_ENV} names, and it names none.`
    );
  }
  if (isWindowsAbsolutePath(configuredPath)) {
    if (configuredPath.includes('\0')) {
      throw new Error(
        `Invalid ${E2E_REAL_ROOT_PATH_ENV} path: Requested path contains null bytes.`
      );
    }
    return configuredPath;
  }
  const resolved = await resolveValidatedPath({ requestedPath: configuredPath });
  if (!resolved.ok) {
    throw new Error(`Invalid ${E2E_REAL_ROOT_PATH_ENV} path: ${resolved.error.message}`);
  }
  if (!(await fileSystem.exists(resolved.path))) {
    throw new Error(
      `${E2E_REAL_ROOT_PATH_ENV} points to a path that does not exist: ${resolved.path}`
    );
  }
  return path.normalize(resolved.path);
}

/**
 * ADR-0029 stage 4: the one workspace-folder service Main keeps. The agent host
 * asks for it (`platform/workspace/pick-folder`) and owns everything after the
 * pick. Resolves the chosen folder, or null when the person cancelled.
 */
export async function pickWorkspaceFolder(
  fileSystem: ElectronFileSystemAdapter
): Promise<string | null> {
  if (isE2eTestMode()) {
    return await resolveE2ePickedFolder(fileSystem);
  }
  try {
    return (await fileSystem.requestDirectoryAccess()).path;
  } catch (cause) {
    if (cause instanceof UserCancelledError) {
      return null;
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

interface RegisterFileSystemIpcHandlersOptions {
  /** Main's native index stops its sources around the host's deletion of the folder's data. */
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
}

/**
 * `fs:deleteRootData` stays in Main while the native index does (ADR-0029 stage 5): its
 * transition wraps the host's `workspace/roots/delete-data`. Every other folder change is
 * the agent host's.
 */
export function registerFileSystemIpcHandlers({
  onDeleteRootData,
}: RegisterFileSystemIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'files', fileSystemContract, fileSystemArgs, {
    deleteRootData: async (rootId: string) =>
      settleIpcResult({ category: 'files', code: 'files.delete-root-data-failed' }, async () => {
        if (!onDeleteRootData) {
          throw refusalError(
            'configuration',
            'files.delete-root-data-unavailable',
            'The main-owned root data deletion capability is unavailable.'
          );
        }
        await onDeleteRootData(rootId);
      }),
  });
  return () => registry.unregisterAll();
}
