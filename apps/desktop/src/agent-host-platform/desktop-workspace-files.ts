import fsPromises from 'node:fs/promises';
import type { HostWorkspaceFiles } from '@brainstrike/agent-host';
import { WORKSPACE_FILES_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { refusalError } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { isFileNotFoundError } from '@brainstrike/assistant-service/node-workspace-services';
import { AccessError, getFileTooLargeMessage } from '@brainstrike/file-system';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { DirectoryHandle } from '@brainstrike/types';
import type { DesktopWorkspaceRoots } from './desktop-workspace-roots';
import { createWorkspaceWatchSessions } from './desktop-workspace-watches';
import type { E2eSyntheticFiles } from './e2e-synthetic-files';

const logger = createLogger('DesktopWorkspaceFiles');

const wireNodes = wireDecoder(WORKSPACE_FILES_RESULT_SCHEMAS['files/read-directory'], {
  errors: 'all',
});

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

/** One validation path for every folder method that takes a client's path. */
/** A client's path, refused as the input it is when it cannot name a file. */
export async function resolveClientPath(requestedPath: string, operation: string): Promise<string> {
  const invalid = (reason: string) =>
    refusalError('input', 'workspace.path-invalid', `Invalid ${operation} path: ${reason}`);
  if (isWindowsAbsolutePath(requestedPath)) {
    if (requestedPath.includes('\0')) {
      throw invalid('Requested path contains null bytes.');
    }
    return requestedPath;
  }
  const resolved = await resolveValidatedPath({ requestedPath });
  if (resolved.ok) {
    return resolved.path;
  }
  throw invalid(resolved.error.message);
}

type FileRead = string | { readonly code: 'NOT_FOUND' | 'TOO_LARGE'; readonly message: string };

/** A missing or oversized file is a value the Explorer drops, not a failure it alerts on. */
async function readOrDrop(filePath: string, read: () => Promise<string>): Promise<FileRead> {
  try {
    return await read();
  } catch (error) {
    const tooLarge = getFileTooLargeMessage(error);
    if (tooLarge) {
      logger.debug('Skipping oversized file read', { message: tooLarge, path: filePath });
      return { code: 'TOO_LARGE', message: tooLarge };
    }
    if (isFileNotFoundError(error)) {
      logger.debug('File not found during read', { path: filePath });
      return {
        code: 'NOT_FOUND',
        message: error instanceof Error ? error.message : 'File not found',
      };
    }
    throw error;
  }
}

interface DesktopWorkspaceFilesOptions {
  /** Deletes a disconnected folder's derived index data. */
  readonly deleteRootData: (rootId: string) => Promise<void>;
  readonly folders: DesktopWorkspaceRoots;
  /** A removal retired a mounted folder, or failed once it may have. */
  readonly onRootsChanged: () => void;
  /** Only in a desktop E2E launch. */
  readonly synthetic?: E2eSyntheticFiles | undefined;
}

/** ADR-0029 stage 4: the Explorer's folders, reads and watchers, served by the agent host. */
export function createDesktopWorkspaceFiles({
  deleteRootData,
  folders,
  onRootsChanged,
  synthetic,
}: DesktopWorkspaceFilesOptions): HostWorkspaceFiles {
  const { roots } = folders;
  const watchSessions = createWorkspaceWatchSessions({
    isSynthetic: async (directoryPath) => (synthetic ? synthetic.owns(directoryPath) : false),
    resolveDirectory: async (directoryPath) => {
      const resolved = await resolveClientPath(directoryPath, 'watch');
      if (!(await fsPromises.stat(resolved)).isDirectory()) {
        throw new Error(`Cannot watch "${resolved}": not a directory.`);
      }
      return resolved;
    },
    startWatch: folders.startVisibleWatch,
  });
  const syntheticOwns = async (requestedPath: string): Promise<boolean> =>
    synthetic !== undefined && (await synthetic.owns(requestedPath));
  const readSyntheticFile = async (filePath: string): Promise<string> => {
    const content = await synthetic?.readFile(filePath);
    if (content === undefined) {
      throw new AccessError(
        `Failed to read file: no E2E fixture registered for ${filePath}`,
        filePath,
        'read'
      );
    }
    return content;
  };
  return {
    'files/add-root-by-path': async ({ path: requestedPath }) => {
      if (requestedPath.length === 0) {
        throw refusalError(
          'input',
          'workspace.path-invalid',
          'The folder path is empty.',
          'Choose a folder.'
        );
      }
      // Picker-less: the recents ledger is the only grant, so an unrecorded path is refused.
      return await roots.addRootByPath(requestedPath);
    },
    'files/delete-root-data': async ({ rootId }) => {
      await deleteRootData(rootId);
      return {};
    },
    'files/e2e/seed-roots': async ({ lastFolderPath, recentPaths, roots: seeded }) => {
      if (!synthetic) {
        throw refusalError(
          'authorization',
          'workspace.e2e-only',
          'Folder seeding is available only to a desktop E2E launch'
        );
      }
      const { storage } = folders;
      await storage.setItem('lastFolderPath', lastFolderPath);
      await storage.setItem(
        'rootsList',
        JSON.stringify(
          seeded.map((root, index) => ({
            addedAt: 1_800_000_000_000 + index,
            path: root.path,
            rootId: root.rootId,
          }))
        )
      );
      if (recentPaths.length > 0) {
        await storage.setItem(
          'recentRootsList',
          JSON.stringify(recentPaths.map((recentPath) => ({ lastGrantedAt: 1, path: recentPath })))
        );
      }
      return {};
    },
    'files/exists': async ({ path: requestedPath }) => {
      if (synthetic && (await syntheticOwns(requestedPath))) {
        return synthetic.exists(requestedPath);
      }
      const resolved = await resolveValidatedPath({ requestedPath });
      if (!resolved.ok) {
        logger.debug('Invalid path provided during exists check', {
          error: resolved.error,
          path: requestedPath,
        });
        return false;
      }
      try {
        await fsPromises.access(resolved.path);
        return true;
      } catch {
        return false;
      }
    },
    'files/read-directory': async ({ handle }) => {
      if (synthetic && (await syntheticOwns(handle.path))) {
        return synthetic.readDirectory(handle.path);
      }
      const resolved: DirectoryHandle = {
        ...handle,
        path: await resolveClientPath(handle.path, 'directory handle'),
      };
      return wireNodes(await roots.readDirectory(resolved));
    },
    'files/read-file': async ({ handle }) => {
      if (await syntheticOwns(handle.path)) {
        return readSyntheticFile(handle.path);
      }
      return readOrDrop(handle.path, async () =>
        roots.readFile({ ...handle, path: await resolveClientPath(handle.path, 'file handle') })
      );
    },
    'files/read-file-by-absolute-path': ({ absolutePath, rootId, rootPath }) =>
      readOrDrop(absolutePath, () => roots.readFileByAbsolutePath(absolutePath, rootPath, rootId)),
    'files/read-file-by-path': async ({ path: absolutePath }) => {
      if (await syntheticOwns(absolutePath)) {
        return readSyntheticFile(absolutePath);
      }
      return readOrDrop(absolutePath, () => roots.readFile(absolutePath));
    },
    'files/recent-roots': () => roots.listRecentRoots(),
    'files/remove-root': async ({ rootId }) => {
      // Removing a mounted folder ends the index's borrow of it, even when the removal then
      // fails: the index re-reads the folders either way.
      const retired = await roots.removeRoot(rootId).catch((error: unknown) => {
        onRootsChanged();
        throw error;
      });
      if (retired) {
        onRootsChanged();
      }
      return {};
    },
    'files/restore-last-folder': () => roots.restoreLastFolder(),
    'files/restore-roots': () => roots.restoreRoots(),
    'files/save-last-folder': async ({ path: folderPath }) => {
      await roots.setLastFolder(folderPath);
      return {};
    },
    'files/watch-telemetry': async () => watchSessions.telemetry(),
    open: (send) => watchSessions.open(send),
  };
}
