import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  AccessError,
  DialogError,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import type { RootDescriptor } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { MOCK_ROOT_PATH } from '../agent-host-platform/e2e-synthetic-files';
import { readE2eFileSystemFixture } from '../e2e-file-system-fixture';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../platform/desktop-ipc-registry';
import { folderPickerContract } from './folder-picker.contract';

const E2E_REAL_ROOT_PATH_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH' as const;

interface FolderPickerOptions {
  /** The agent host mounts the picked folder; the pick is its grant. */
  readonly addPicked: (handle: DirectoryHandle) => Promise<RootDescriptor>;
  /** Only in a desktop E2E launch: the fixture file the agent host serves its folders from. */
  readonly e2eFixturePath: string | null;
  readonly fileSystem: ElectronFileSystemAdapter;
}

/** The dialog's failures, each a refusal the window shows with its remedy. */
function pickerFailure(cause: unknown): unknown {
  if (cause instanceof UserCancelledError) {
    return refusalError(
      'input',
      'workspace.selection-cancelled',
      'No folder was selected.',
      'Choose a folder to continue.'
    );
  }
  if (cause instanceof PermissionError) {
    return new BoundaryFailureError(
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
    return new BoundaryFailureError(
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
    return new BoundaryFailureError(
      fault({
        category: 'availability',
        code: 'workspace.picker-unavailable',
        message: 'The folder picker could not open.',
        remedy: 'Try opening the folder picker again.',
      }),
      { cause }
    );
  }
  return cause;
}

/**
 * An E2E launch has no dialog: the folder the current test's fixture names, else the real
 * folder the launch was given, else the default mock folder the agent host serves.
 */
async function e2ePickedFolder(fixturePath: string): Promise<DirectoryHandle> {
  const fixture = await readE2eFileSystemFixture(fixturePath);
  if (fixture) {
    return fixture.rootHandle;
  }
  const configuredPath = process.env[E2E_REAL_ROOT_PATH_ENV]?.trim();
  if (configuredPath) {
    const resolved = await resolveValidatedPath({ requestedPath: configuredPath });
    if (!resolved.ok) {
      throw new Error(`Invalid ${E2E_REAL_ROOT_PATH_ENV}: ${resolved.error.message}`);
    }
    return {
      kind: 'directory',
      name: path.basename(resolved.path),
      path: resolved.path,
      platform: 'electron',
    };
  }
  return {
    kind: 'directory',
    name: 'mock-test-directory',
    path: MOCK_ROOT_PATH,
    platform: 'electron',
  };
}

/**
 * ADR-0029 stage 4: the OS folder dialog is Main's; the folder it picked is the agent host's.
 * Both pickers mount the pick in the host, which records it as a root and a recent folder.
 */
export function registerFolderPickerIpcHandlers(options: FolderPickerOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const pickAndAdd = async (): Promise<RootDescriptor> => {
    let handle: DirectoryHandle;
    try {
      handle = options.e2eFixturePath
        ? await e2ePickedFolder(options.e2eFixturePath)
        : await options.fileSystem.requestDirectoryAccess();
    } catch (cause) {
      throw pickerFailure(cause);
    }
    return await options.addPicked(handle);
  };
  registerDomain(registry, 'files', folderPickerContract, {
    addRoot: () =>
      settleIpcResult({ category: 'files', code: 'files.add-root-failed' }, () => pickAndAdd()),
    requestDirectoryAccess: () =>
      settleIpcResult(
        { category: 'files', code: 'files.request-directory-access-failed' },
        async () => (await pickAndAdd()).handle
      ),
  });
  return () => registry.unregisterAll();
}
