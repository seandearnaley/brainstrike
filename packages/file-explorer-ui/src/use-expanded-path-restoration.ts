import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { extractPathSegments } from '@brainstrike/utils/path-utils';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { getPathDepth } from '@brainstrike/utils/tree-operations';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const logger = createLogger('ExpandedPathRestoration');

/**
 * Module-level lock for restoration to prevent concurrent runs.
 * React's concurrent rendering can cause multiple effect instances to run
 * before any of them could set refs, resulting in duplicate restoration work.
 */
const restorationLock = {
  inProgress: false,
  folderId: null as string | null,
};

/**
 * Reset the restoration lock state.
 * @internal Exported only for test cleanup. Do not use in production code.
 */
export function __resetRestorationLock(): void {
  restorationLock.inProgress = false;
  restorationLock.folderId = null;
}

function getAllAncestorDirectories(filePath: string): string[] {
  const isAbsolute = filePath.startsWith('/');
  const segments = extractPathSegments(filePath);
  segments.pop();

  const ancestors: string[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = isAbsolute ? '/' : '';
    ancestors.push(prefix + segments.slice(0, index).join('/'));
  }
  return ancestors;
}

function getParentDirectoriesForSelectedFiles(selectedFiles: Set<string>): Set<string> {
  const parentDirectories = new Set<string>();
  for (const compositeKey of selectedFiles) {
    try {
      const { path } = decodeFileSelection(compositeKey);
      const ancestors = getAllAncestorDirectories(path);
      for (const ancestor of ancestors) {
        parentDirectories.add(ancestor);
      }
    } catch {
      // Ignore invalid composite keys.
    }
  }
  return parentDirectories;
}

function getRestorationSkipReason(
  currentRootFolderId: string | null,
  isTreeLoading: boolean,
  fileTreeLength: number
): 'empty-tree' | 'no-folder-id' | 'still-loading' | null {
  if (!currentRootFolderId) {
    return 'no-folder-id';
  }
  if (isTreeLoading) {
    return 'still-loading';
  }
  if (fileTreeLength === 0) {
    return 'empty-tree';
  }
  return null;
}

export interface RestorationProgress {
  currentPath: string | null;
  loaded: number;
  total: number;
}

interface FileExplorerStoreAccessor {
  getState: () => FileExplorerState;
}

interface PathsToRestorePlan {
  allPathsToRestore: Set<string>;
  parentDirectoriesOfSelectedFiles: Set<string>;
  queryCoveredDirectories: Set<string>;
}

export interface UseExpandedPathRestorationArgs {
  currentRootFolderId: string | null;
  disabled?: boolean;
  fileTree: readonly IFileNode[];
  isTreeLoading: boolean;
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  setExpandedPaths: (paths: Set<string>) => void;
  store: FileExplorerStoreAccessor;
}

export interface ExpandedPathRestorationState {
  isRestorationSettled: boolean;
  isRestoringExpandedPaths: boolean;
  restorationProgress: RestorationProgress | null;
}

interface HandleRestorationSkipArgs {
  currentRootFolderId: string | null;
  fileTreeLength: number;
  isTreeLoading: boolean;
  setSettledFolderId: Dispatch<SetStateAction<string | null>>;
}

function handleRestorationSkip(args: HandleRestorationSkipArgs): boolean {
  const { currentRootFolderId, fileTreeLength, isTreeLoading, setSettledFolderId } = args;
  const restorationSkipReason = getRestorationSkipReason(
    currentRootFolderId,
    isTreeLoading,
    fileTreeLength
  );

  if (restorationSkipReason === 'no-folder-id' || restorationSkipReason === 'still-loading') {
    return true;
  }
  if (restorationSkipReason === 'empty-tree') {
    if (currentRootFolderId) {
      setSettledFolderId(currentRootFolderId);
    }
    return true;
  }

  return false;
}

function handleRestorationLock(
  currentRootFolderId: string,
  setSettledFolderId: Dispatch<SetStateAction<string | null>>
): boolean {
  if (restorationLock.folderId === currentRootFolderId && !restorationLock.inProgress) {
    setSettledFolderId(currentRootFolderId);
    return true;
  }

  if (restorationLock.inProgress) {
    logger.debug('[Restoration Effect] Skipped - restoration in progress');
    return true;
  }

  return false;
}

function buildPathsToRestorePlan(storeState: FileExplorerState): PathsToRestorePlan {
  const queryCoveredDirectories =
    storeState.selectionModel.mode === 'query'
      ? new Set(storeState.selectionModel.queryDescriptor?.coveredDirectoryPaths ?? [])
      : new Set<string>();
  const parentDirectoriesOfSelectedFiles = getParentDirectoriesForSelectedFiles(
    storeState.selectedFilePaths
  );
  const allPathsToRestore = new Set([
    ...storeState.expandedDirectoryPaths,
    ...parentDirectoriesOfSelectedFiles,
    ...queryCoveredDirectories,
  ]);

  return {
    allPathsToRestore,
    parentDirectoriesOfSelectedFiles,
    queryCoveredDirectories,
  };
}

function logPathsToRestore(
  currentRootFolderId: string,
  plan: PathsToRestorePlan,
  storeState: FileExplorerState
): void {
  logger.debug('[Restoration Effect] Paths to restore', {
    folderId: currentRootFolderId,
    expandedPathCount: storeState.expandedDirectoryPaths.size,
    parentDirsOfSelectedFiles: plan.parentDirectoriesOfSelectedFiles.size,
    queryCoveredDirectoryCount: plan.queryCoveredDirectories.size,
    selectedFileCount: storeState.selectedFilePaths.size,
    totalPathsToRestore: plan.allPathsToRestore.size,
  });
}

interface RestoreExpandedPathsArgs {
  currentRootFolderId: string;
  currentRootFolderIdRef: RefObject<string | null>;
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  plan: PathsToRestorePlan;
  setExpandedPaths: (paths: Set<string>) => void;
  setIsRestoringExpandedPaths: Dispatch<SetStateAction<boolean>>;
  setRestorationProgress: Dispatch<SetStateAction<RestorationProgress | null>>;
  setSettledFolderId: Dispatch<SetStateAction<string | null>>;
  sortedPaths: string[];
  store: FileExplorerStoreAccessor;
}

async function restoreExpandedPaths(args: RestoreExpandedPathsArgs): Promise<void> {
  const {
    currentRootFolderId,
    currentRootFolderIdRef,
    loadSpecificPaths,
    plan,
    setExpandedPaths,
    setIsRestoringExpandedPaths,
    setRestorationProgress,
    setSettledFolderId,
    sortedPaths,
    store,
  } = args;

  try {
    await loadSpecificPaths(sortedPaths, (loaded, progressTotal, currentPath) => {
      setRestorationProgress({ loaded, total: progressTotal, currentPath });
    });

    if (currentRootFolderIdRef.current !== currentRootFolderId) {
      logger.debug('Skipping restored expanded paths for stale root', {
        currentFolderId: currentRootFolderIdRef.current,
        restoredFolderId: currentRootFolderId,
      });
      return;
    }

    const currentExpandedPaths = store.getState().expandedDirectoryPaths;
    const restoredExpandedPaths = new Set([...currentExpandedPaths, ...plan.allPathsToRestore]);
    setExpandedPaths(restoredExpandedPaths);

    logger.info('Restored expanded directories', {
      folderId: currentRootFolderId,
      totalPaths: sortedPaths.length,
    });
  } catch (error) {
    logger.warn('Failed to restore expanded directories', { error });
  } finally {
    restorationLock.inProgress = false;
    setIsRestoringExpandedPaths(false);
    setRestorationProgress(null);
    if (currentRootFolderIdRef.current === currentRootFolderId) {
      setSettledFolderId(currentRootFolderId);
    }
  }
}

export function useExpandedPathRestoration(
  args: UseExpandedPathRestorationArgs
): ExpandedPathRestorationState {
  const {
    currentRootFolderId,
    disabled = false,
    fileTree,
    isTreeLoading,
    loadSpecificPaths,
    setExpandedPaths,
    store,
  } = args;
  const [isRestoringExpandedPaths, setIsRestoringExpandedPaths] = useState(false);
  const [restorationProgress, setRestorationProgress] = useState<RestorationProgress | null>(null);
  const [settledFolderId, setSettledFolderId] = useState<string | null>(null);
  const currentRootFolderIdRef = useRef<string | null>(currentRootFolderId);
  const previousRootFolderIdRef = useRef<string | null>(currentRootFolderId);

  useLayoutEffect(() => {
    currentRootFolderIdRef.current = currentRootFolderId;
  }, [currentRootFolderId]);

  useEffect(() => {
    if (previousRootFolderIdRef.current === currentRootFolderId) {
      return;
    }
    previousRootFolderIdRef.current = currentRootFolderId;
    setSettledFolderId(null);
    setIsRestoringExpandedPaths(false);
    setRestorationProgress(null);
  }, [currentRootFolderId]);

  useEffect(() => {
    if (disabled) {
      return;
    }

    if (
      handleRestorationSkip({
        currentRootFolderId,
        fileTreeLength: fileTree.length,
        isTreeLoading,
        setSettledFolderId,
      })
    ) {
      return;
    }

    if (!currentRootFolderId) {
      return;
    }

    if (handleRestorationLock(currentRootFolderId, setSettledFolderId)) {
      return;
    }

    restorationLock.inProgress = true;
    restorationLock.folderId = currentRootFolderId;

    const storeState = store.getState();
    const plan = buildPathsToRestorePlan(storeState);
    logPathsToRestore(currentRootFolderId, plan, storeState);

    if (plan.allPathsToRestore.size === 0) {
      logger.debug('[Restoration Effect] Skipped - no paths to restore');
      restorationLock.inProgress = false;
      setSettledFolderId(currentRootFolderId);
      return;
    }

    setIsRestoringExpandedPaths(true);

    logger.info('Restoring expanded directories and file parent directories', {
      folderId: currentRootFolderId,
      expandedPathCount: storeState.expandedDirectoryPaths.size,
      parentDirsOfSelectedFilesCount: plan.parentDirectoriesOfSelectedFiles.size,
      totalPathCount: plan.allPathsToRestore.size,
    });

    const sortedPaths = [...plan.allPathsToRestore].sort(
      (left, right) => getPathDepth(left) - getPathDepth(right)
    );
    const total = sortedPaths.length;
    setRestorationProgress({ loaded: 0, total, currentPath: null });

    void restoreExpandedPaths({
      currentRootFolderId,
      currentRootFolderIdRef,
      loadSpecificPaths,
      plan,
      setExpandedPaths,
      setIsRestoringExpandedPaths,
      setRestorationProgress,
      setSettledFolderId,
      sortedPaths,
      store,
    });
  }, [
    currentRootFolderId,
    disabled,
    fileTree.length,
    isTreeLoading,
    loadSpecificPaths,
    setExpandedPaths,
    store,
  ]);

  return {
    isRestorationSettled: currentRootFolderId !== null && settledFolderId === currentRootFolderId,
    isRestoringExpandedPaths,
    restorationProgress,
  };
}
