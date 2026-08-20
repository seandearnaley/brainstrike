import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { getPathDepth } from '@brainstrike/file-tree-worker';
import { createLogger } from '@brainstrike/logging';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPathWithinRoot, normalizePathForRootScope } from './utils/root-scoped-paths';

const logger = createLogger('ExpandedPathRestoration');
export const MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS = 100;

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
  failed: boolean;
  inProgress: boolean;
  ownerToken: symbol | null;
  restorationKey: string | null;
  runToken: symbol | null;
}

const restorationLocks = new Map<string, RestorationLockEntry>();

/** Helper to get-or-create the lock entry for a given folderId. */
function getRestorationLock(folderId: string): RestorationLockEntry {
  let entry = restorationLocks.get(folderId);
  if (!entry) {
    entry = {
      failed: false,
      inProgress: false,
      ownerToken: null,
      restorationKey: null,
      runToken: null,
    };
    restorationLocks.set(folderId, entry);
  }
  return entry;
}

/**
 * Drop only the calling provider's lock entry. Ownership lets an unmount
 * release its active restoration without deleting another provider's lock,
 * while a late finalizer cannot recreate or overwrite the remount's entry.
 */
function releaseRestorationLock(folderId: string, ownerToken: symbol): void {
  const entry = restorationLocks.get(folderId);
  if (entry?.ownerToken === ownerToken) {
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
    const charCode = filePath.charCodeAt(index);
    if (charCode === 47 || charCode === 92) {
      inSegment = false;
    } else if (!inSegment) {
      segmentCount += 1;
      inSegment = true;
    }
  }
  return segmentCount;
}

function appendAncestorSegment(
  currentPath: string,
  segment: string,
  absolutePrefix: string,
  separator: string
): string {
  if (currentPath !== '') {
    return `${currentPath}${separator}${segment}`;
  }
  return `${absolutePrefix}${segment}`;
}

export function __getAllAncestorDirectories(filePath: string): string[] {
  const separator = filePath.includes('\\') ? '\\' : '/';
  const absolutePrefix = filePath.startsWith('\\\\') ? '\\\\' : filePath.startsWith('/') ? '/' : '';
  const ancestorCount = countNonEmptyPathSegments(filePath) - 1;
  if (ancestorCount <= 0) {
    return [];
  }

  const ancestors: string[] = [];
  let currentPath = '';
  let segmentStart = -1;
  let emittedSegments = 0;
  for (let index = 0; index <= filePath.length; index += 1) {
    const charCode = filePath.charCodeAt(index);
    if (index < filePath.length && charCode !== 47 && charCode !== 92) {
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
    currentPath = appendAncestorSegment(currentPath, segment, absolutePrefix, separator);
    ancestors.push(currentPath);
    if (emittedSegments === ancestorCount) {
      break;
    }
    segmentStart = -1;
  }
  return ancestors;
}

function getParentDirectoriesForSelectedFiles(
  selectedFiles: Set<string>,
  currentRootFolderId: string
): Set<string> {
  const parentDirectories = new Set<string>();
  for (const compositeKey of selectedFiles) {
    try {
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (folderId !== currentRootFolderId) {
        continue;
      }
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

function getDirectoriesForCurrentSelection(
  storeState: FileExplorerState,
  currentRootFolderId: string
): Set<string> {
  const directories = getParentDirectoriesForSelectedFiles(
    storeState.selectedFilePaths,
    currentRootFolderId
  );
  if (storeState.selectionModel.mode !== 'query') {
    return directories;
  }

  if (storeState.selectionModel.queryDescriptor?.folderId !== currentRootFolderId) {
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
  omitted?: number;
  total: number;
}

interface FileExplorerStoreAccessor {
  getState: () => FileExplorerState;
}

interface PathsToRestorePlan {
  allPathsToRestore: Set<string>;
  omittedPathCount: number;
  omittedPersistedPaths: Set<string>;
  parentDirectoriesOfSelectedFiles: Set<string>;
  queryCoveredDirectories: Set<string>;
  requestedPathCount: number;
}

export interface UseExpandedPathRestorationArgs {
  currentRootFolderId: string | null;
  currentRootPath?: string | null;
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
    if (lock.failed) {
      // A visible non-abort failure gets one automatic attempt per provider /
      // root / restoration key. Loading-state transitions must not hammer the
      // same unreadable directory; remounting or changing the key releases
      // this owner-scoped record and is the explicit retry boundary.
      logger.debug('[Restoration Effect] Skipped - previous restoration failed', {
        folderId: currentRootFolderId,
      });
      return true;
    }
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

function sortRestorationPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) => {
    const depthDifference =
      getPathDepth(normalizePathForRootScope(left)) -
      getPathDepth(normalizePathForRootScope(right));
    return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
  });
}

function buildPathsToRestorePlan(
  storeState: FileExplorerState,
  currentRootFolderId: string,
  currentRootPath: string | null | undefined
): PathsToRestorePlan {
  const queryCoveredDirectories =
    storeState.selectionModel.mode === 'query' &&
    storeState.selectionModel.queryDescriptor?.folderId === currentRootFolderId
      ? new Set(
          (storeState.selectionModel.queryDescriptor.coveredDirectoryPaths ?? []).filter((path) =>
            isPathWithinRoot(path, currentRootPath)
          )
        )
      : new Set<string>();
  const parentDirectoriesOfSelectedFiles = getParentDirectoriesForSelectedFiles(
    storeState.selectedFilePaths,
    currentRootFolderId
  );
  const scopedParentDirectories = new Set(
    [...parentDirectoriesOfSelectedFiles].filter((path) => isPathWithinRoot(path, currentRootPath))
  );
  const persistedPaths = new Set(
    [...storeState.expandedDirectoryPaths].filter((path) => isPathWithinRoot(path, currentRootPath))
  );
  const priorityPaths = sortRestorationPaths(
    new Set([...scopedParentDirectories, ...queryCoveredDirectories])
  );
  const remainingPersistedPaths = sortRestorationPaths(
    [...persistedPaths].filter(
      (path) => !(scopedParentDirectories.has(path) || queryCoveredDirectories.has(path))
    )
  );
  const requestedPaths = [...priorityPaths, ...remainingPersistedPaths];
  const restoredPaths = requestedPaths.slice(0, MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS);
  const omittedPaths = requestedPaths.slice(MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS);
  const omittedPersistedPaths = new Set(omittedPaths.filter((path) => persistedPaths.has(path)));

  return {
    allPathsToRestore: new Set(restoredPaths),
    omittedPathCount: omittedPaths.length,
    omittedPersistedPaths,
    parentDirectoriesOfSelectedFiles: scopedParentDirectories,
    queryCoveredDirectories,
    requestedPathCount: requestedPaths.length,
  };
}

function logPathsToRestore(
  currentRootFolderId: string,
  plan: PathsToRestorePlan,
  storeState: FileExplorerState
): void {
  logger.debug('[Restoration Effect] Paths to restore', {
    expandedPathCount: storeState.expandedDirectoryPaths.size,
    folderId: currentRootFolderId,
    omittedPathCount: plan.omittedPathCount,
    parentDirsOfSelectedFiles: plan.parentDirectoriesOfSelectedFiles.size,
    queryCoveredDirectoryCount: plan.queryCoveredDirectories.size,
    requestedPathCount: plan.requestedPathCount,
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
  restorationOwnerToken: symbol;
  restorationRunToken: symbol;
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
    restorationOwnerToken,
    restorationRunToken,
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
  let outcome: 'cancelled' | 'failed' | 'retired' | 'succeeded' = 'retired';

  try {
    await loadSpecificPaths(sortedPaths, (loaded, progressTotal, currentPath) => {
      setRestorationProgress({
        currentPath,
        loaded,
        omitted: plan.omittedPathCount,
        total: progressTotal,
      });
    });

    if (currentRootFolderIdRef.current !== currentRootFolderId) {
      logger.debug('Skipping restored expanded paths for stale root', {
        currentFolderId: currentRootFolderIdRef.current,
        restoredFolderId: currentRootFolderId,
      });
      return;
    }

    const ownedLock = restorationLocks.get(currentRootFolderId);
    if (
      ownedLock?.inProgress !== true ||
      ownedLock.ownerToken !== restorationOwnerToken ||
      ownedLock.restorationKey !== restorationKey ||
      ownedLock.runToken !== restorationRunToken
    ) {
      logger.debug('Skipping restored expanded paths after restoration ownership was retired', {
        folderId: currentRootFolderId,
      });
      return;
    }

    const currentExpandedPaths = new Set(store.getState().expandedDirectoryPaths);
    for (const omittedPath of plan.omittedPersistedPaths) {
      currentExpandedPaths.delete(omittedPath);
    }
    const restoredExpandedPaths = new Set([...currentExpandedPaths, ...plan.allPathsToRestore]);
    setExpandedPaths(restoredExpandedPaths);

    logger.info('Restored expanded directories', {
      folderId: currentRootFolderId,
      totalPaths: sortedPaths.length,
    });
    outcome = 'succeeded';
  } catch (error) {
    if (isAbortError(error)) {
      outcome = 'cancelled';
      logger.debug('Automatic expanded-directory restoration was cancelled', {
        folderId: currentRootFolderId,
      });
    } else {
      outcome = 'failed';
      logger.warn('Failed to restore expanded directories', { error });
    }
  } finally {
    const ownedLock = restorationLocks.get(currentRootFolderId);
    const ownsLock =
      ownedLock?.ownerToken === restorationOwnerToken &&
      ownedLock.restorationKey === restorationKey &&
      ownedLock.runToken === restorationRunToken;
    if (ownsLock) {
      if (outcome === 'cancelled' || outcome === 'retired') {
        restorationLocks.delete(currentRootFolderId);
      } else {
        ownedLock.failed = outcome === 'failed';
        ownedLock.inProgress = false;
        ownedLock.runToken = null;
      }
    }
    // Clear this instance's in-progress tracker so a subsequent root-switch
    // can proceed once this restore completes.
    const ownsInstanceAttempt = instanceInProgressFolderIdRef.current === currentRootFolderId;
    if (ownsInstanceAttempt) {
      instanceInProgressFolderIdRef.current = null;
      setIsRestoringExpandedPaths(false);
      setRestorationProgress(null);
    }
    if (
      outcome === 'succeeded' &&
      ownsLock &&
      currentRootFolderIdRef.current === currentRootFolderId
    ) {
      setSettledFolderId(currentRootFolderId);
      setSettledRestorationKey(restorationKey);
    }
    // Physical settlement is the ordering boundary for retry and root/key
    // rollover. Wake the effect for every attempt still owned by this hook;
    // the lock outcome decides whether it retries, remains failed, or settles.
    if (ownsInstanceAttempt) {
      setRestorationCompletionVersion((version) => version + 1);
    }
  }
}

export function useExpandedPathRestoration(
  args: UseExpandedPathRestorationArgs
): ExpandedPathRestorationState {
  const {
    currentRootFolderId,
    currentRootPath,
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
  const [restorationOwnerToken] = useState(() => Symbol('expanded-path-restoration-owner'));
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
        releaseRestorationLock(folderIdAtMount, restorationOwnerToken);
      }
    };
  }, [currentRootFolderId, restorationOwnerToken]);

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

  // biome-ignore lint/plugin: Restores persisted local tree state after the matching root commits; no remote fetch occurs.
  useEffect(() => {
    if (disabled) {
      return;
    }

    if (
      handleRestorationSkip({
        currentRootFolderId,
        fileTreeLength: fileTree.length,
        isTreeLoading,
        restorationKey,
        setSettledFolderId,
        setSettledRestorationKey,
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
    const restorationRunToken = Symbol('expanded-path-restoration-run');
    lock.inProgress = true;
    lock.failed = false;
    lock.ownerToken = restorationOwnerToken;
    lock.restorationKey = restorationKey;
    lock.runToken = restorationRunToken;
    instanceInProgressFolderIdRef.current = currentRootFolderId;

    const storeState = store.getState();
    const plan = buildPathsToRestorePlan(storeState, currentRootFolderId, currentRootPath);
    logPathsToRestore(currentRootFolderId, plan, storeState);

    if (plan.allPathsToRestore.size === 0) {
      logger.debug('[Restoration Effect] Skipped - no paths to restore');
      const emptyPlanLock = getRestorationLock(currentRootFolderId);
      emptyPlanLock.failed = false;
      emptyPlanLock.inProgress = false;
      emptyPlanLock.runToken = null;
      instanceInProgressFolderIdRef.current = null;
      setSettledFolderId(currentRootFolderId);
      setSettledRestorationKey(restorationKey);
      return;
    }

    setIsRestoringExpandedPaths(true);

    if (plan.omittedPersistedPaths.size > 0) {
      const boundedExpandedPaths = new Set(storeState.expandedDirectoryPaths);
      for (const omittedPath of plan.omittedPersistedPaths) {
        boundedExpandedPaths.delete(omittedPath);
      }
      setExpandedPaths(boundedExpandedPaths);
      logger.warn('Automatic directory restoration was bounded to keep the UI responsive', {
        folderId: currentRootFolderId,
        omittedPathCount: plan.omittedPathCount,
        requestedPathCount: plan.requestedPathCount,
        restoredPathCount: plan.allPathsToRestore.size,
      });
    }

    logger.info('Restoring expanded directories and file parent directories', {
      expandedPathCount: storeState.expandedDirectoryPaths.size,
      folderId: currentRootFolderId,
      parentDirsOfSelectedFilesCount: plan.parentDirectoriesOfSelectedFiles.size,
      totalPathCount: plan.allPathsToRestore.size,
    });

    const sortedPaths = sortRestorationPaths(plan.allPathsToRestore);
    const total = sortedPaths.length;
    setRestorationProgress({
      currentPath: null,
      loaded: 0,
      omitted: plan.omittedPathCount,
      total,
    });

    void restoreExpandedPaths({
      currentRootFolderId,
      currentRootFolderIdRef,
      instanceInProgressFolderIdRef,
      loadSpecificPaths,
      plan,
      restorationKey,
      restorationOwnerToken,
      restorationRunToken,
      setExpandedPaths,
      setIsRestoringExpandedPaths,
      setRestorationCompletionVersion,
      setRestorationProgress,
      setSettledFolderId,
      setSettledRestorationKey,
      sortedPaths,
      store,
    });
  }, [
    currentRootFolderId,
    currentRootPath,
    disabled,
    fileTree.length,
    isTreeLoading,
    loadSpecificPaths,
    restorationCompletionVersion,
    restorationKey,
    restorationOwnerToken,
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
  currentRootPath?: string | null;
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
    currentRootPath,
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
    const parentDirectories = new Set(
      [...getDirectoriesForCurrentSelection(storeState, currentRootFolderId)].filter((path) =>
        isPathWithinRoot(path, currentRootPath)
      )
    );
    if (parentDirectories.size === 0) {
      return;
    }

    const currentExpanded = storeState.expandedDirectoryPaths;
    const missingParents = [...parentDirectories].filter((path) => !currentExpanded.has(path));
    if (missingParents.length === 0) {
      return;
    }

    const sortedParents = sortRestorationPaths(missingParents);
    const boundedParents = sortedParents.slice(0, MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS);
    const omittedParentCount = sortedParents.length - boundedParents.length;
    if (omittedParentCount > 0) {
      logger.warn('Selected-file parent expansion was bounded to keep the UI responsive', {
        folderId: currentRootFolderId,
        omittedParentCount,
        requestedParentCount: sortedParents.length,
        restoredParentCount: boundedParents.length,
      });
    }

    void loadSpecificPaths(boundedParents)
      .then(() => {
        if (latestExpansionRequestRef.current !== expansionRequestId) {
          return;
        }
        const latestExpanded = store.getState().expandedDirectoryPaths;
        setExpandedPaths(new Set([...latestExpanded, ...boundedParents]));
      })
      .catch((error: unknown) => {
        logger.warn('Failed to expand parent directories for selected files', { error });
      });
  }, [
    currentRootFolderId,
    currentRootPath,
    disabled,
    isRestorationSettled,
    loadSpecificPaths,
    selectionVersion,
    setExpandedPaths,
    store,
  ]);
}
