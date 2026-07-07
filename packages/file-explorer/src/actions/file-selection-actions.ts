import type { FileExplorerState, SelectionQueryDescriptor } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import {
  DEFAULT_SELECTION_CHUNK_SIZE,
  IDLE_CALLBACK_TIMEOUT_MS,
} from '../constants/selection-constants';
import type { GetState, SetState } from '../types/store-types';
import {
  createNewFolderState,
  getFocusedSelectionCount,
  getForeignSelectionCount,
} from '../utils/file-explorer-utils';
import { resolveQuerySelection } from '../utils/query-selection-manifest';

const logger = createLogger('FileSelectionActions');

export interface ChunkedSelectionOptions {
  /** Number of files to process per chunk (default: DEFAULT_SELECTION_CHUNK_SIZE = 100) */
  chunkSize?: number;
  /** Callback for progress updates (filesProcessed, totalFiles) */
  onProgress?: (processed: number, total: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface ChunkedSelectionResult {
  /** Total files that were added */
  addedCount: number;
  /** Whether the operation was cancelled */
  cancelled: boolean;
  /** Whether max selection limit was reached */
  limitReached: boolean;
}

export interface FileSelectionActions {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  /**
   * Add multiple files with chunked processing to avoid blocking the main thread.
   * Uses requestIdleCallback to process files in batches, keeping the UI responsive.
   * Best for selecting 100+ files at once.
   *
   * **Cancellation Strategy:**
   * Pass an AbortSignal via options.signal to cancel in-flight operations.
   * The function checks for cancellation before each chunk and after yielding.
   * When cancelled, returns { cancelled: true } with partial progress.
   *
   * **Race Condition Handling:**
   * If multiple chunked selections are triggered rapidly, callers should:
   * 1. Cancel any in-flight operation via AbortController.abort()
   * 2. Start the new operation with a fresh AbortController
   * This prevents interleaved updates from concurrent operations.
   */
  addMultipleSelectedFilesChunked: (
    folderId: string,
    paths: string[],
    options?: ChunkedSelectionOptions
  ) => Promise<ChunkedSelectionResult>;
  addSelectedFile: (folderId: string | null, path: string) => void;
  clearSelectedFiles: () => void;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  removeSelectedFile: (folderId: string | null, path: string) => void;
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
  toggleSelectedFile: (folderId: string | null, path: string) => void;
}

/** Schedule work during browser idle time with error handling. */
function scheduleChunk(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scheduleCallback =
      typeof requestIdleCallback === 'undefined'
        ? (cb: () => void) =>
            setTimeout(() => {
              try {
                cb();
              } catch (error) {
                reject(error);
              }
            }, 0)
        : (cb: () => void) =>
            requestIdleCallback(
              () => {
                try {
                  cb();
                } catch (error) {
                  reject(error);
                }
              },
              { timeout: IDLE_CALLBACK_TIMEOUT_MS }
            );

    scheduleCallback(resolve);
  });
}

interface ComputeKeysResult {
  cancelled: boolean;
  computedKeys: string[];
  processedCount: number;
  wasCapped: boolean;
}

interface QuerySelectionMutationResult {
  addedCount: number;
  limitReached: boolean;
}

function shouldStopKeyComputation(params: {
  cancelled: boolean;
  exhaustedBudget: boolean;
  processedCount: number;
  totalPaths: number;
}): boolean {
  const { cancelled, exhaustedBudget, processedCount, totalPaths } = params;
  return cancelled || exhaustedBudget || processedCount >= totalPaths;
}

function appendChunkKeys(args: {
  chunkEnd: number;
  computedKeys: string[];
  existingSelectedFiles: ReadonlySet<string>;
  folderId: string;
  paths: string[];
  processedCount: number;
  remainingBudget: number;
  seenKeys: Set<string>;
}): boolean {
  const {
    chunkEnd,
    computedKeys,
    existingSelectedFiles,
    folderId,
    paths,
    processedCount,
    remainingBudget,
    seenKeys,
  } = args;

  for (let i = processedCount; i < chunkEnd; i++) {
    const path = paths[i];
    if (path === undefined) {
      continue;
    }

    const compositeKey = encodeFileSelection(folderId, path);
    if (seenKeys.has(compositeKey) || existingSelectedFiles.has(compositeKey)) {
      continue;
    }

    seenKeys.add(compositeKey);
    computedKeys.push(compositeKey);
    if (computedKeys.length >= remainingBudget) {
      return true;
    }
  }

  return false;
}

function createExplicitSelectionModel(selectedFiles: Set<string>) {
  return {
    ...createEmptySelectionModel(),
    explicitPaths: new Set(selectedFiles),
  };
}

function sortPaths(paths: Set<string>): string[] {
  return Array.from(paths).sort(defaultCollator.compare);
}

function buildCompatibleSelectedFilePaths(
  folderId: string,
  descriptor: SelectionQueryDescriptor
): Set<string> {
  const compositeKeys = new Set<string>();
  for (const path of descriptor.includedPaths) {
    compositeKeys.add(encodeFileSelection(folderId, path));
  }
  return compositeKeys;
}

function isReadyQueryManifest(
  descriptor: SelectionQueryDescriptor,
  manifest: FileExplorerState['querySelectionManifest']
): manifest is NonNullable<FileExplorerState['querySelectionManifest']> {
  return Boolean(
    manifest &&
      manifest.status === 'ready' &&
      manifest.fingerprint === descriptor.manifestFingerprint &&
      manifest.snapshotId === descriptor.manifestSnapshotId
  );
}

function applyQuerySelectionMutation(args: {
  additions: readonly string[];
  folderId: string;
  removals: readonly string[];
  state: FileExplorerState;
}): Partial<FileExplorerState> {
  const { additions, folderId, removals, state } = args;
  const descriptor = state.selectionModel.queryDescriptor;
  const manifest = state.querySelectionManifest;

  if (
    state.selectionModel.mode !== 'query' ||
    !descriptor ||
    descriptor.folderId !== folderId ||
    !isReadyQueryManifest(descriptor, manifest)
  ) {
    return {};
  }

  const resolvedSelection = resolveQuerySelection(descriptor, manifest);
  const baseSelectedPaths = manifest.pathSet;
  const includedPaths = new Set(descriptor.includedPaths);
  const excludedPaths = new Set(descriptor.excludedPaths);
  let totalSelectedCount = resolvedSelection.selectedCount;
  let didChange = false;

  const isSelected = (path: string): boolean => {
    if (includedPaths.has(path)) {
      return true;
    }
    if (excludedPaths.has(path)) {
      return false;
    }
    return baseSelectedPaths.has(path);
  };

  for (const path of removals) {
    if (includedPaths.delete(path)) {
      totalSelectedCount -= 1;
      didChange = true;
      continue;
    }
    if (baseSelectedPaths.has(path) && !excludedPaths.has(path)) {
      excludedPaths.add(path);
      totalSelectedCount -= 1;
      didChange = true;
    }
  }

  for (const path of additions) {
    if (isSelected(path)) {
      continue;
    }
    if (totalSelectedCount >= state.maxSelectionCount) {
      break;
    }
    const wasExcluded = excludedPaths.has(path);
    if (wasExcluded && baseSelectedPaths.has(path)) {
      if (totalSelectedCount >= state.maxSelectionCount) {
        break;
      }
      excludedPaths.delete(path);
      totalSelectedCount += 1;
      didChange = true;
      continue;
    }
    includedPaths.add(path);
    totalSelectedCount += 1;
    didChange = true;
  }

  if (!didChange) {
    return {};
  }

  const nextDescriptor: SelectionQueryDescriptor = {
    ...descriptor,
    excludedPaths: sortPaths(excludedPaths),
    includedPaths: sortPaths(includedPaths),
    totalSelectedCount,
  };

  return {
    selectedFilePaths: buildCompatibleSelectedFilePaths(folderId, nextDescriptor),
    selectionModel: {
      ...state.selectionModel,
      queryDescriptor: nextDescriptor,
    },
    selectionVersion: state.selectionVersion + 1,
  };
}

function applyQuerySelectionAndMeasure(args: {
  additions: readonly string[];
  folderId: string;
  removals: readonly string[];
  set: (
    partial: Partial<FileExplorerState> | ((state: FileExplorerState) => Partial<FileExplorerState>)
  ) => void;
}): QuerySelectionMutationResult {
  const { additions, folderId, removals, set } = args;
  let addedCount = 0;
  let limitReached = false;

  set((state) => {
    const nextPartial = applyQuerySelectionMutation({
      additions,
      folderId,
      removals,
      state,
    });
    const nextDescriptor =
      nextPartial.selectionModel?.queryDescriptor ?? state.selectionModel.queryDescriptor;
    const previousSelectedCount = state.selectionModel.queryDescriptor?.totalSelectedCount ?? 0;

    addedCount = nextDescriptor ? nextDescriptor.totalSelectedCount - previousSelectedCount : 0;
    limitReached = (nextDescriptor?.totalSelectedCount ?? 0) >= state.maxSelectionCount;

    return nextPartial;
  });

  return { addedCount, limitReached };
}

function resolveSelectionModelAfterExplicitMutation(
  currentSelectionModel: FileExplorerState['selectionModel'],
  newSelectedFiles: Set<string>
): FileExplorerState['selectionModel'] {
  if (!(currentSelectionModel && 'mode' in currentSelectionModel)) {
    return createExplicitSelectionModel(newSelectedFiles);
  }
  if (currentSelectionModel.mode === 'explicit') {
    return {
      ...currentSelectionModel,
      explicitPaths: new Set(newSelectedFiles),
      materializedAt: null,
      materializedPaths: null,
      queryDescriptor: null,
      ruleSetJson: null,
    };
  }
  return createExplicitSelectionModel(newSelectedFiles);
}

/**
 * Phase 1: Compute composite keys in chunks, yielding between chunks.
 * Caps iteration to the remaining selection budget to avoid unnecessary work.
 */
async function computeKeysInChunks(
  folderId: string,
  paths: string[],
  remainingBudget: number,
  chunkSize: number,
  existingSelectedFiles: ReadonlySet<string>,
  signal?: AbortSignal,
  onProgress?: (processed: number, total: number) => void
): Promise<ComputeKeysResult> {
  const computedKeys: string[] = [];
  const seenKeys = new Set<string>();
  let processedCount = 0;
  let cancelled = false;
  let exhaustedBudget = remainingBudget === 0;

  while (
    !shouldStopKeyComputation({
      cancelled,
      exhaustedBudget,
      processedCount,
      totalPaths: paths.length,
    })
  ) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    await scheduleChunk();

    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    const chunkEnd = Math.min(processedCount + chunkSize, paths.length);
    exhaustedBudget = appendChunkKeys({
      chunkEnd,
      computedKeys,
      existingSelectedFiles,
      folderId,
      paths,
      processedCount,
      remainingBudget,
      seenKeys,
    });

    processedCount = chunkEnd;
    onProgress?.(processedCount, paths.length);
  }

  return {
    cancelled,
    computedKeys,
    processedCount,
    wasCapped: exhaustedBudget && processedCount < paths.length,
  };
}

/**
 * Phase 6 forest hardening: route an explicit-mode mutation for a NON-focused
 * root into that root's folderState. Checkbox writes in a non-focused section
 * race the click-bubble focus switch — written to the top-level (focused) set
 * they get snapshotted into the WRONG root's folderState by setCurrentFolderId
 * and the checkbox flickers/arrives late. Routing by the mutation's folderId
 * makes the write order-independent: whichever of the write and the focus
 * switch lands first, the key ends up in the same place.
 *
 * Additions clamp against the WORKSPACE-GLOBAL maxSelectionCount — never the
 * folder snapshot's copy. Persisted folderStates carry stale per-folder caps
 * (the old default of 10) that silently truncated foreign selections.
 */
function applyForeignExplicitMutation(
  state: FileExplorerState,
  folderId: string,
  additions: readonly string[],
  removals: readonly string[]
): {
  changes: Partial<FileExplorerState>;
  addedCount: number;
  limitReached: boolean;
} {
  const base = state.folderStates[folderId] ?? createNewFolderState(state);
  const selected = new Set(base.selectedFilePaths);
  // Whole-forest cap: this root's set may grow only into the budget left by
  // the focused selection and every OTHER active root's selection.
  const othersCount = getFocusedSelectionCount(state) + getForeignSelectionCount(state, folderId);
  const limit = Math.max(0, state.maxSelectionCount - othersCount);
  let addedCount = 0;
  let limitReached = false;
  for (const path of additions) {
    if (selected.size >= limit) {
      limitReached = true;
      break;
    }
    const key = encodeFileSelection(folderId, path);
    if (!selected.has(key)) {
      selected.add(key);
      addedCount++;
    }
  }
  for (const path of removals) {
    selected.delete(encodeFileSelection(folderId, path));
  }
  return {
    addedCount,
    changes: {
      folderStates: {
        ...state.folderStates,
        [folderId]: {
          ...base,
          lastAccessed: Date.now(),
          selectedFilePaths: selected,
          selectionModel: {
            ...base.selectionModel,
            explicitPaths: new Set(selected),
            mode: 'explicit',
          },
        },
      },
      selectionVersion: state.selectionVersion + 1,
    },
    limitReached,
  };
}

/** True when the mutation targets a root other than the focused one. */
/**
 * Slots available to the FOCUSED root's top-level set under the
 * whole-forest cap: maxSelectionCount minus every other active root's
 * folderState selection.
 */
function focusedSelectionBudget(state: FileExplorerState): number {
  return Math.max(0, state.maxSelectionCount - getForeignSelectionCount(state));
}

function isForeignFolderMutation(state: FileExplorerState, folderId: string): boolean {
  return state.currentFolderId !== null && folderId !== state.currentFolderId;
}

/** Toggle within a foreign root's folderState (see applyForeignExplicitMutation). */
function applyForeignToggleMutation(
  state: FileExplorerState,
  folderId: string,
  path: string
): Partial<FileExplorerState> {
  const key = encodeFileSelection(folderId, path);
  const isSelected = state.folderStates[folderId]?.selectedFilePaths.has(key) ?? false;
  return applyForeignExplicitMutation(
    state,
    folderId,
    isSelected ? [] : [path],
    isSelected ? [path] : []
  ).changes;
}

export const createFileSelectionActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FileSelectionActions => ({
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    logger.debug('addMultipleSelectedFiles called', {
      folderId,
      pathCount: paths.length,
      samplePaths: paths.slice(0, 3),
    });

    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          additions: paths,
          folderId,
          removals: [],
          state,
        });
      }
      if (isForeignFolderMutation(state, folderId)) {
        return applyForeignExplicitMutation(state, folderId, paths, []).changes;
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const previousSize = newSelectedFiles.size;
      let currentSize = previousSize;
      const budget = focusedSelectionBudget(state);

      for (const path of paths) {
        if (currentSize >= budget) {
          break; // Stop once the whole-forest budget is reached
        }
        const compositeKey = encodeFileSelection(folderId, path);
        if (!newSelectedFiles.has(compositeKey)) {
          newSelectedFiles.add(compositeKey);
          currentSize++;
        }
      }

      logger.debug('addMultipleSelectedFiles complete', {
        addedCount: newSelectedFiles.size - previousSize,
        newSize: newSelectedFiles.size,
        previousSize,
        sampleKeys: [...newSelectedFiles].slice(0, 3),
      });

      return {
        querySelectionManifest: null,
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  addMultipleSelectedFilesChunked: async (
    folderId: string,
    paths: string[],
    options: ChunkedSelectionOptions = {}
  ): Promise<ChunkedSelectionResult> => {
    const { chunkSize = DEFAULT_SELECTION_CHUNK_SIZE, signal, onProgress } = options;

    logger.debug('addMultipleSelectedFilesChunked started', {
      chunkSize,
      folderId,
      pathCount: paths.length,
    });

    // Phase 6: foreign-root batches merge into that root's folderState in one
    // update — the chunked optimization targets huge TOP-LEVEL set rebuilds.
    const entryState = get();
    if (
      entryState.selectionModel.mode !== 'query' &&
      isForeignFolderMutation(entryState, folderId)
    ) {
      let addedCount = 0;
      let limitReached = false;
      set((state) => {
        const result = applyForeignExplicitMutation(state, folderId, paths, []);
        addedCount = result.addedCount;
        limitReached = result.limitReached;
        return result.changes;
      });
      onProgress?.(paths.length, paths.length);
      return { addedCount, cancelled: false, limitReached };
    }

    // For small selections, use the synchronous version
    if (paths.length <= chunkSize) {
      const stateBefore = get();

      if (stateBefore.selectionModel.mode === 'query') {
        const { addedCount, limitReached } = applyQuerySelectionAndMeasure({
          additions: paths,
          folderId,
          removals: [],
          set,
        });
        onProgress?.(paths.length, paths.length);
        return { addedCount, cancelled: false, limitReached };
      }

      let addedCount = 0;
      let limitReached = false;
      set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        let currentSize = newSelectedFiles.size;
        const budget = focusedSelectionBudget(state);

        for (const path of paths) {
          if (currentSize >= budget) {
            limitReached = true;
            break;
          }
          const compositeKey = encodeFileSelection(folderId, path);
          if (!newSelectedFiles.has(compositeKey)) {
            newSelectedFiles.add(compositeKey);
            currentSize++;
            addedCount++;
          }
        }

        return {
          querySelectionManifest: null,
          selectedFilePaths: newSelectedFiles,
          selectionModel: resolveSelectionModelAfterExplicitMutation(
            state.selectionModel,
            newSelectedFiles
          ),
          selectionVersion: state.selectionVersion + 1,
        };
      });

      onProgress?.(paths.length, paths.length);

      return { addedCount, cancelled: false, limitReached };
    }

    // For large selections, compute composite keys in chunks (yielding to browser),
    // then apply all keys in a single state update. This avoids O(k*n) Set copies
    // where k = number of chunks and n = existing selection size.

    // Budget snapshot is taken before async work. It may become stale if other
    // actions mutate selection concurrently, but Phase 2's set() reads the
    // authoritative latest state — this cap is purely an optimization to skip
    // unnecessary key computation.
    const currentState = get();
    if (currentState.selectionModel.mode === 'query') {
      const { addedCount, limitReached } = applyQuerySelectionAndMeasure({
        additions: paths,
        folderId,
        removals: [],
        set,
      });
      onProgress?.(paths.length, paths.length);
      return { addedCount, cancelled: false, limitReached };
    }

    const remainingBudget = Math.max(
      0,
      currentState.maxSelectionCount - currentState.selectedFilePaths.size
    );

    const { computedKeys, processedCount, cancelled, wasCapped } = await computeKeysInChunks(
      folderId,
      paths,
      remainingBudget,
      chunkSize,
      currentState.selectedFilePaths,
      signal,
      onProgress
    );

    // Phase 2: Single atomic state update with all computed keys.
    // `addedCount` and `limitReached` are mutated inside the `set()` updater
    // and read after it returns. This is safe because Zustand's `set()` invokes
    // the updater synchronously before returning.
    let addedCount = 0;
    let limitReached = wasCapped;

    if (computedKeys.length > 0) {
      set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        let currentSize = newSelectedFiles.size;
        const budget = focusedSelectionBudget(state);

        for (const compositeKey of computedKeys) {
          if (currentSize >= budget) {
            limitReached = true;
            break;
          }
          if (!newSelectedFiles.has(compositeKey)) {
            newSelectedFiles.add(compositeKey);
            currentSize++;
            addedCount++;
          }
        }

        return {
          querySelectionManifest: null,
          selectedFilePaths: newSelectedFiles,
          selectionModel: resolveSelectionModelAfterExplicitMutation(
            state.selectionModel,
            newSelectedFiles
          ),
          selectionVersion: state.selectionVersion + 1,
        };
      });
    }

    logger.debug('addMultipleSelectedFilesChunked complete', {
      addedCount,
      cancelled,
      limitReached,
      processedCount,
      totalPaths: paths.length,
    });

    return { addedCount, cancelled, limitReached };
  },

  addSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          additions: [path],
          folderId,
          removals: [],
          state,
        });
      }
      if (isForeignFolderMutation(state, folderId)) {
        return applyForeignExplicitMutation(state, folderId, [path], []).changes;
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      // Check against the whole-forest budget before adding
      if (newSelectedFiles.size < focusedSelectionBudget(state)) {
        newSelectedFiles.add(encodeFileSelection(folderId, path));
      }
      return {
        querySelectionManifest: null,
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  clearSelectedFiles: () => {
    set((state) => ({
      querySelectionManifest: null,
      selectedFilePaths: new Set(),
      selectionModel:
        state.selectionModel?.mode === 'explicit'
          ? resolveSelectionModelAfterExplicitMutation(state.selectionModel, new Set<string>())
          : createExplicitSelectionModel(new Set<string>()),
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          additions: [],
          folderId,
          removals: paths,
          state,
        });
      }
      if (isForeignFolderMutation(state, folderId)) {
        return applyForeignExplicitMutation(state, folderId, [], paths).changes;
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      for (const path of paths) {
        const compositeKey = encodeFileSelection(folderId, path);
        newSelectedFiles.delete(compositeKey);
      }
      return {
        querySelectionManifest: null,
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  removeSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          additions: [],
          folderId,
          removals: [path],
          state,
        });
      }
      if (isForeignFolderMutation(state, folderId)) {
        return applyForeignExplicitMutation(state, folderId, [], [path]).changes;
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      newSelectedFiles.delete(encodeFileSelection(folderId, path));
      return {
        querySelectionManifest: null,
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => {
    // Ensure all files in the set are properly encoded composite keys
    const validatedFiles = new Set<string>();
    for (const file of selectedFiles) {
      const separatorIndex = file.indexOf('|@|');
      const hasSingleSeparator = separatorIndex === file.lastIndexOf('|@|');
      const hasFolderId = separatorIndex > 0;
      const hasPath = separatorIndex >= 0 && separatorIndex < file.length - 3;

      if (hasSingleSeparator && hasFolderId && hasPath) {
        validatedFiles.add(file);
      }
    }
    set((state) => ({
      querySelectionManifest: null,
      selectedFilePaths: validatedFiles,
      selectionModel: resolveSelectionModelAfterExplicitMutation(
        state.selectionModel,
        validatedFiles
      ),
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  toggleSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        const resolvedQuerySelection = resolveQuerySelection(
          state.selectionModel.queryDescriptor,
          state.querySelectionManifest
        );
        const isCurrentlySelected = resolvedQuerySelection.pathSet.has(path);
        return applyQuerySelectionMutation({
          additions: isCurrentlySelected ? [] : [path],
          folderId,
          removals: isCurrentlySelected ? [path] : [],
          state,
        });
      }
      if (isForeignFolderMutation(state, folderId)) {
        return applyForeignToggleMutation(state, folderId, path);
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const compositeKey = encodeFileSelection(folderId, path);
      if (newSelectedFiles.has(compositeKey)) {
        newSelectedFiles.delete(compositeKey);
      } else if (newSelectedFiles.size < focusedSelectionBudget(state)) {
        // Check against the whole-forest budget before adding
        newSelectedFiles.add(compositeKey);
      }
      return {
        querySelectionManifest: null,
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },
});
