import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { getPathDepth } from '@brainstrike/utils/tree-operations';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const logger = createLogger('ExpandedPathRestoration');

/**
 * Module-level lock for restoration to prevent concurrent runs.
 * React's concurrent rendering can cause multiple effect instances to run
 * before any of them could set refs, resulting in duplicate restoration work.
 *
 * Keyed by folderId so that forest-mode providers for DIFFERENT roots do not
 * block each other. Before this was a single shared object; in multi-root mode
 * two FileTreeProviders mounting concurrently (e.g. rootA and rootB) would
 * share the lock — the second provider would see `inProgress=true` for the
 * first and skip permanently, leaving its tree un-restored.
 *
 * Accepted phase-4 limitation: two web roots with the SAME directory name
 * share a folderId (path = bare name) and therefore one lock entry — the
 * second provider's restoration is skipped once the first completes for the
 * same restoration key. Consistent with the same-path display-state collision
 * accepted across phase 4; resolved when stores re-key by RootId (phase 5).
 */
interface RestorationLockEntry {
  inProgress: boolean;
  restorationKey: string | null;
}

const restorationLocks = new Map<string, RestorationLockEntry>();

/** Helper to get-or-create the lock entry for a given folderId. */
function getRestorationLock(folderId: string): RestorationLockEntry {
  let entry = restorationLocks.get(folderId);
  if (!entry) {
    entry = { inProgress: false, restorationKey: null };
    restorationLocks.set(folderId, entry);
  }
  return entry;
}

/**
 * Drop a root's lock entry once no restoration is running — keeps the
 * module-level Map from accumulating entries as roots come and go over a
 * long session. Safe to call on unmount: a fresh mount re-creates the entry.
 */
function releaseRestorationLock(folderId: string): void {
  const entry = restorationLocks.get(folderId);
  if (entry && !entry.inProgress) {
    restorationLocks.delete(folderId);
  }
}

/**
 * Reset the restoration lock state.
 * @internal Exported only for test cleanup. Do not use in production code.
 */
export function __resetRestorationLock(): void {
  restorationLocks.clear();
}

function countNonEmptyPathSegments(filePath: string): number {
  let segmentCount = 0;
  let inSegment = false;
  for (let index = 0; index < filePath.length; index += 1) {
    if (filePath.charCodeAt(index) === 47) {
      inSegment = false;
    } else if (!inSegment) {
      segmentCount += 1;
      inSegment = true;
    }
  }
  return segmentCount;
}

function appendAncestorSegment(currentPath: string, segment: string, isAbsolute: boolean): string {
  if (currentPath !== '') {
    return `${currentPath}/${segment}`;
  }
  return `${isAbsolute ? '/' : ''}${segment}`;
}

export function __getAllAncestorDirectories(filePath: string): string[] {
  const isAbsolute = filePath.startsWith('/');
  const ancestorCount = countNonEmptyPathSegments(filePath) - 1;
  if (ancestorCount <= 0) {
    return [];
  }

  const ancestors: string[] = [];
  let currentPath = '';
  let segmentStart = -1;
  let emittedSegments = 0;
  for (let index = 0; index <= filePath.length; index += 1) {
    if (index < filePath.length && filePath.charCodeAt(index) !== 47) {
      if (segmentStart === -1) {
        segmentStart = index;
      }
      continue;
    }

    if (segmentStart === -1) {
      continue;
    }

    emittedSegments += 1;
    const segment = filePath.slice(segmentStart, index);
    // Restoration runs for every persisted/selected path; append one segment at
    // a time instead of rebuilding each ancestor from sliced segment arrays.
    currentPath = appendAncestorSegment(currentPath, segment, isAbsolute);
    ancestors.push(currentPath);
    if (emittedSegments === ancestorCount) {
      break;
    }
    segmentStart = -1;
  }
  return ancestors;
}

function getParentDirectoriesForSelectedFiles(selectedFiles: Set<string>): Set<string> {
  const parentDirectories = new Set<string>();
  for (const compositeKey of selectedFiles) {
    try {
      const { path } = decodeFileSelection(compositeKey);
      const ancestors = __getAllAncestorDirectories(path);
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
  const lock = getRestorationLock(currentRootFolderId);

  if (lock.restorationKey === restorationKey && !lock.inProgress) {
    setSettledFolderId(currentRootFolderId);
    setSettledRestorationKey(restorationKey);
    return true;
  }

  if (lock.inProgress) {
    logger.debug('[Restoration Effect] Skipped - restoration in progress', {
      folderId: currentRootFolderId,
    });
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
  instanceInProgressFolderIdRef: RefObject<string | null>;
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
    instanceInProgressFolderIdRef,
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
    getRestorationLock(currentRootFolderId).inProgress = false;
    // Clear this instance's in-progress tracker so a subsequent root-switch
    // can proceed once this restore completes.
    if (instanceInProgressFolderIdRef.current === currentRootFolderId) {
      instanceInProgressFolderIdRef.current = null;
    }
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
  /**
   * Tracks which folderId THIS INSTANCE is currently restoring (in-flight async).
   * Used to block root-switch mid-restore within the same provider instance:
   * if this instance started restoring rootA and the root switches to rootB before
   * rootA finishes, rootB should not start until rootA's in-flight completes.
   * Per-instance (useRef) so concurrent forest-mode providers do NOT block each
   * other — each provider instance has its own independent tracking.
   */
  const instanceInProgressFolderIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    currentRootFolderIdRef.current = currentRootFolderId;
  }, [currentRootFolderId]);

  // Release this root's module-level lock entry on unmount (or when the root
  // changes) so the Map doesn't accumulate entries as roots come and go.
  useEffect(() => {
    const folderIdAtMount = currentRootFolderId;
    return () => {
      if (folderIdAtMount) {
        releaseRestorationLock(folderIdAtMount);
      }
    };
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

    // Instance-level guard: if THIS provider instance already has an in-flight
    // restore for a DIFFERENT folderId (root switched mid-restore), block the
    // new root until the old one finishes. This preserves the single-provider
    // root-switch safety without blocking concurrent forest-mode providers
    // (each of which has its own instanceInProgressFolderIdRef).
    if (
      instanceInProgressFolderIdRef.current !== null &&
      instanceInProgressFolderIdRef.current !== currentRootFolderId
    ) {
      logger.debug('[Restoration Effect] Skipped - instance root-switch mid-restore', {
        inProgressFolderId: instanceInProgressFolderIdRef.current,
        newFolderId: currentRootFolderId,
      });
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

    const lock = getRestorationLock(currentRootFolderId);
    lock.inProgress = true;
    lock.restorationKey = restorationKey;
    instanceInProgressFolderIdRef.current = currentRootFolderId;

    const storeState = store.getState();
    const plan = buildPathsToRestorePlan(storeState);
    logPathsToRestore(currentRootFolderId, plan, storeState);

    if (plan.allPathsToRestore.size === 0) {
      logger.debug('[Restoration Effect] Skipped - no paths to restore');
      getRestorationLock(currentRootFolderId).inProgress = false;
      instanceInProgressFolderIdRef.current = null;
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
      instanceInProgressFolderIdRef,
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
