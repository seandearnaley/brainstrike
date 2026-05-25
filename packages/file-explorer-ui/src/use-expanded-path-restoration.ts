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
  restorationKey: null as string | null,
};

/**
 * Reset the restoration lock state.
 * @internal Exported only for test cleanup. Do not use in production code.
 */
export function __resetRestorationLock(): void {
  restorationLock.inProgress = false;
  restorationLock.folderId = null;
  restorationLock.restorationKey = null;
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

function getDirectoriesForCurrentSelection(storeState: FileExplorerState): Set<string> {
  const directories = getParentDirectoriesForSelectedFiles(storeState.selectedFilePaths);
  if (storeState.selectionModel.mode !== 'query') {
    return directories;
  }

  const coveredDirectoryPaths =
    storeState.selectionModel.queryDescriptor?.coveredDirectoryPaths ?? [];
  for (const directoryPath of coveredDirectoryPaths) {
    directories.add(directoryPath);
  }
  return directories;
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
  restorationKey?: string | undefined;
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
  restorationKey: string;
  setSettledFolderId: Dispatch<SetStateAction<string | null>>;
  setSettledRestorationKey: Dispatch<SetStateAction<string | null>>;
}

function handleRestorationSkip(args: HandleRestorationSkipArgs): boolean {
  const {
    currentRootFolderId,
    fileTreeLength,
    isTreeLoading,
    setSettledFolderId,
    setSettledRestorationKey,
    restorationKey,
  } = args;
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
      setSettledRestorationKey(restorationKey);
    }
    return true;
  }

  return false;
}

function handleRestorationLock(
  currentRootFolderId: string,
  restorationKey: string,
  setSettledFolderId: Dispatch<SetStateAction<string | null>>,
  setSettledRestorationKey: Dispatch<SetStateAction<string | null>>
): boolean {
  if (
    restorationLock.folderId === currentRootFolderId &&
    restorationLock.restorationKey === restorationKey &&
    !restorationLock.inProgress
  ) {
    setSettledFolderId(currentRootFolderId);
    setSettledRestorationKey(restorationKey);
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
  restorationKey: string;
  setExpandedPaths: (paths: Set<string>) => void;
  setIsRestoringExpandedPaths: Dispatch<SetStateAction<boolean>>;
  setRestorationCompletionVersion: Dispatch<SetStateAction<number>>;
  setRestorationProgress: Dispatch<SetStateAction<RestorationProgress | null>>;
  setSettledFolderId: Dispatch<SetStateAction<string | null>>;
  setSettledRestorationKey: Dispatch<SetStateAction<string | null>>;
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
    setSettledRestorationKey,
    setRestorationCompletionVersion,
    restorationKey,
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
      setSettledRestorationKey(restorationKey);
      setRestorationCompletionVersion((version) => version + 1);
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
    restorationKey = 'initial',
    setExpandedPaths,
    store,
  } = args;
  const [isRestoringExpandedPaths, setIsRestoringExpandedPaths] = useState(false);
  const [restorationProgress, setRestorationProgress] = useState<RestorationProgress | null>(null);
  const [settledFolderId, setSettledFolderId] = useState<string | null>(null);
  const [settledRestorationKey, setSettledRestorationKey] = useState<string | null>(null);
  const [restorationCompletionVersion, setRestorationCompletionVersion] = useState(0);
  const currentRootFolderIdRef = useRef<string | null>(currentRootFolderId);
  const previousRootFolderIdRef = useRef<string | null>(currentRootFolderId);
  const previousRestorationKeyRef = useRef<string>(restorationKey);

  useLayoutEffect(() => {
    currentRootFolderIdRef.current = currentRootFolderId;
  }, [currentRootFolderId]);

  useEffect(() => {
    if (
      previousRootFolderIdRef.current === currentRootFolderId &&
      previousRestorationKeyRef.current === restorationKey
    ) {
      return;
    }
    previousRootFolderIdRef.current = currentRootFolderId;
    previousRestorationKeyRef.current = restorationKey;
    setSettledFolderId(null);
    setSettledRestorationKey(null);
    setIsRestoringExpandedPaths(false);
    setRestorationProgress(null);
  }, [currentRootFolderId, restorationKey]);

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
        setSettledRestorationKey,
        restorationKey,
      })
    ) {
      return;
    }

    if (!currentRootFolderId) {
      return;
    }

    if (
      handleRestorationLock(
        currentRootFolderId,
        restorationKey,
        setSettledFolderId,
        setSettledRestorationKey
      )
    ) {
      return;
    }

    restorationLock.inProgress = true;
    restorationLock.folderId = currentRootFolderId;
    restorationLock.restorationKey = restorationKey;

    const storeState = store.getState();
    const plan = buildPathsToRestorePlan(storeState);
    logPathsToRestore(currentRootFolderId, plan, storeState);

    if (plan.allPathsToRestore.size === 0) {
      logger.debug('[Restoration Effect] Skipped - no paths to restore');
      restorationLock.inProgress = false;
      setSettledFolderId(currentRootFolderId);
      setSettledRestorationKey(restorationKey);
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
      setSettledRestorationKey,
      setRestorationCompletionVersion,
      restorationKey,
      sortedPaths,
      store,
    });
  }, [
    currentRootFolderId,
    disabled,
    fileTree.length,
    isTreeLoading,
    loadSpecificPaths,
    restorationCompletionVersion,
    restorationKey,
    setExpandedPaths,
    store,
  ]);

  return {
    isRestorationSettled:
      currentRootFolderId !== null &&
      settledFolderId === currentRootFolderId &&
      settledRestorationKey === restorationKey,
    isRestoringExpandedPaths,
    restorationProgress,
  };
}

export interface UseExpandSelectedFileParentDirectoriesArgs {
  currentRootFolderId: string | null;
  disabled?: boolean;
  isRestorationSettled: boolean;
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  selectionVersion: number;
  setExpandedPaths: (paths: Set<string>) => void;
  store: FileExplorerStoreAccessor;
}

/**
 * Expands parent directories for newly selected files without re-running full
 * expanded-path restoration (which reloads the entire persisted expansion set).
 */
export function useExpandSelectedFileParentDirectories(
  args: UseExpandSelectedFileParentDirectoriesArgs
): void {
  const {
    currentRootFolderId,
    disabled = false,
    isRestorationSettled,
    loadSpecificPaths,
    selectionVersion,
    setExpandedPaths,
    store,
  } = args;
  const latestExpansionRequestRef = useRef(0);

  useEffect(() => {
    latestExpansionRequestRef.current += 1;
    const expansionRequestId = latestExpansionRequestRef.current;

    if (disabled || !currentRootFolderId || !isRestorationSettled) {
      return;
    }

    const storeState = store.getState();
    const parentDirectories = getDirectoriesForCurrentSelection(storeState);
    if (parentDirectories.size === 0) {
      return;
    }

    const currentExpanded = storeState.expandedDirectoryPaths;
    const missingParents = [...parentDirectories].filter((path) => !currentExpanded.has(path));
    if (missingParents.length === 0) {
      return;
    }

    const sortedParents = missingParents.sort(
      (left, right) => getPathDepth(left) - getPathDepth(right)
    );

    void loadSpecificPaths(sortedParents)
      .then(() => {
        if (latestExpansionRequestRef.current !== expansionRequestId) {
          return;
        }
        const latestExpanded = store.getState().expandedDirectoryPaths;
        setExpandedPaths(new Set([...latestExpanded, ...parentDirectories]));
      })
      .catch((error: unknown) => {
        logger.warn('Failed to expand parent directories for selected files', { error });
      });
  }, [
    currentRootFolderId,
    disabled,
    isRestorationSettled,
    loadSpecificPaths,
    selectionVersion,
    setExpandedPaths,
    store,
  ]);
}
