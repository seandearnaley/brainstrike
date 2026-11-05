import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FolderRequests } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import type { FileExplorerState, RecentRootEntry } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useState } from 'react';

const logger = createLogger('FileFolderStatus');

/**
 * Where a file tab's folder stands. The tab body, its side pane and its breadcrumb all read this
 * one status, so they never disagree. Only a request for this folder makes it `opening`: another
 * folder being added, opened or restored leaves it as it is.
 */
export type FileFolderStatus =
  | { readonly kind: 'open' }
  /** A mount of this folder is in flight, or the start-up restore has not answered yet. */
  | { readonly kind: 'opening'; readonly name: string | null }
  /**
   * Not open, and nothing is opening it. `path` is the folder to reopen, when it is known
   * (Recents, or a mount asked for this session); `failure` is why its last mount failed.
   */
  | {
      readonly failure: string | null;
      readonly kind: 'closed';
      readonly name: string | null;
      readonly path: string | null;
    };

export const OPEN_FOLDER: FileFolderStatus = { kind: 'open' };

const UNKNOWN_CLOSED_FOLDER: FileFolderStatus = {
  failure: null,
  kind: 'closed',
  name: null,
  path: null,
};

const NO_RECENTS: readonly RecentRootEntry[] = [];

function contains(folder: string, file: string): boolean {
  return file === folder || file.startsWith(`${folder}/`) || file.startsWith(`${folder}\\`);
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).findLast(Boolean) ?? path;
}

/**
 * The status of a file whose folder is not open. Its folder is the longest known folder path that
 * contains the file (a Recents entry, or a path with a mount in flight or failed) and is not
 * already open under another folder: when Recents nest, opening the inner folder never satisfies
 * a tab that belongs to the outer one, so the next status offers the outer folder instead.
 */
export function unopenedFileFolderStatus({
  filePath,
  openPaths,
  recents,
  requests,
  restorePending,
}: {
  readonly filePath: string;
  /** The paths of the folders open now, none of them this file's. */
  readonly openPaths: ReadonlySet<string>;
  readonly recents: readonly RecentRootEntry[];
  readonly requests: FolderRequests;
  readonly restorePending: boolean;
}): FileFolderStatus {
  const names = new Map<string, string>();
  for (const path of [...requests.opening.keys(), ...requests.failures.keys()]) {
    names.set(path, baseName(path));
  }
  for (const entry of recents) {
    names.set(entry.path, entry.displayName);
  }
  let folder: string | null = null;
  for (const path of names.keys()) {
    if (
      !openPaths.has(path) &&
      contains(path, filePath) &&
      (folder === null || path.length > folder.length)
    ) {
      folder = path;
    }
  }
  const name = folder === null ? null : (names.get(folder) ?? null);
  if (restorePending || (folder !== null && requests.opening.has(folder))) {
    return { kind: 'opening', name };
  }
  return {
    failure: folder === null ? null : (requests.failures.get(folder) ?? null),
    kind: 'closed',
    name,
    path: folder,
  };
}

/** Recents as the host lists them, read again whenever a folder change may have changed them. */
function useRecentFolders(
  listRecentRoots: (() => Promise<readonly RecentRootEntry[]>) | undefined,
  recentRootsRevision: number
): readonly RecentRootEntry[] {
  const [loaded, setLoaded] = useState<{
    readonly entries: readonly RecentRootEntry[];
    readonly source: NonNullable<typeof listRecentRoots>;
  } | null>(null);
  useEffect(() => {
    if (!listRecentRoots) {
      return;
    }
    let cancelled = false;
    listRecentRoots().then(
      (entries) => {
        if (!cancelled) {
          setLoaded({ entries, source: listRecentRoots });
        }
      },
      (error: unknown) => {
        // A closed folder then has no name or Reopen; the tab still says it is closed.
        logger.warn('Recent folders could not be read', { error });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [listRecentRoots, recentRootsRevision]);
  return listRecentRoots && loaded?.source === listRecentRoots ? loaded.entries : NO_RECENTS;
}

/** What a file tab's folder status is read from: the explorer's folders and requests. */
export interface FileFolderSources {
  readonly addRootDirectoryByPath: ((path: string) => Promise<unknown>) | undefined;
  readonly canLoadWithoutTree: boolean;
  readonly folderRequests: FolderRequests;
  readonly listRecentRoots: (() => Promise<readonly RecentRootEntry[]>) | undefined;
  readonly recentRootsRevision: number;
  readonly restorePending: boolean;
  readonly rootDescriptors: FileExplorerState['rootDescriptors'];
}

/**
 * The folder status of a file tab, by its composite key, and Reopen for a closed one. On a
 * platform that reads files through the tree (web), a folder that is not open is closed, unnamed.
 * Reopen mounts the folder by its path, as Re-add does: the host mounts only a folder granted
 * before or a managed worktree, and a refusal lands in the status with its reason. It is
 * `undefined` where the platform cannot mount by path (web).
 */
export function useFileFolderStatus({
  addRootDirectoryByPath,
  canLoadWithoutTree,
  folderRequests,
  listRecentRoots,
  recentRootsRevision,
  restorePending,
  rootDescriptors,
}: FileFolderSources): {
  readonly fileFolderStatus: (compositeKey: string) => FileFolderStatus;
  readonly reopenFolder: ((path: string) => void) | undefined;
} {
  const recents = useRecentFolders(listRecentRoots, recentRootsRevision);
  const openPaths = useMemo(
    () => new Set(Object.values(rootDescriptors).map((descriptor) => descriptor.path)),
    [rootDescriptors]
  );
  const fileFolderStatus = useCallback(
    (compositeKey: string): FileFolderStatus => {
      let selection: { folderId: string; path: string };
      try {
        selection = decodeFileSelection(compositeKey);
      } catch {
        return UNKNOWN_CLOSED_FOLDER;
      }
      if (rootDescriptors[selection.folderId] !== undefined) {
        return OPEN_FOLDER;
      }
      if (!canLoadWithoutTree) {
        // The web cannot mount a folder by its path: a folder that left is closed until the
        // person opens it again.
        return restorePending ? { kind: 'opening', name: null } : UNKNOWN_CLOSED_FOLDER;
      }
      return unopenedFileFolderStatus({
        filePath: selection.path,
        openPaths,
        recents,
        requests: folderRequests,
        restorePending,
      });
    },
    [canLoadWithoutTree, folderRequests, openPaths, recents, restorePending, rootDescriptors]
  );
  const reopenFolder = useMemo(
    () =>
      addRootDirectoryByPath
        ? (path: string) => {
            // The tab shows why; the log names no path, since a folder's path is private.
            addRootDirectoryByPath(path).catch((error: unknown) => {
              logger.info('A closed folder could not be reopened', {
                errorName: error instanceof Error ? error.name : typeof error,
              });
            });
          }
        : undefined,
    [addRootDirectoryByPath]
  );
  return { fileFolderStatus, reopenFolder };
}
