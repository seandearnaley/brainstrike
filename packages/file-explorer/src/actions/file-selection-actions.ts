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
    includedPaths: sortPaths(includedPaths),
    excludedPaths: sortPaths(excludedPaths),
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
      state,
      folderId,
      additions,
      removals,
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
      materializedPaths: null,
      materializedAt: null,
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
    computedKeys,
    processedCount,
    cancelled,
    wasCapped: exhaustedBudget && processedCount < paths.length,
  };
}

export const createFileSelectionActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FileSelectionActions => ({
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
      selectedFilePaths: validatedFiles,
      selectionModel: resolveSelectionModelAfterExplicitMutation(
        state.selectionModel,
        validatedFiles
      ),
      querySelectionManifest: null,
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  addSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          state,
          folderId,
          additions: [path],
          removals: [],
        });
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      // Check against maxSelectionCount before adding
      if (newSelectedFiles.size < state.maxSelectionCount) {
        newSelectedFiles.add(encodeFileSelection(folderId, path));
      }
      return {
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        querySelectionManifest: null,
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
          state,
          folderId,
          additions: [],
          removals: [path],
        });
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      newSelectedFiles.delete(encodeFileSelection(folderId, path));
      return {
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        querySelectionManifest: null,
        selectionVersion: state.selectionVersion + 1,
      };
    });
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
          state,
          folderId,
          additions: isCurrentlySelected ? [] : [path],
          removals: isCurrentlySelected ? [path] : [],
        });
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const compositeKey = encodeFileSelection(folderId, path);
      if (newSelectedFiles.has(compositeKey)) {
        newSelectedFiles.delete(compositeKey);
      } else if (newSelectedFiles.size < state.maxSelectionCount) {
        // Check against maxSelectionCount before adding
        newSelectedFiles.add(compositeKey);
      }
      return {
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        querySelectionManifest: null,
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  clearSelectedFiles: () => {
    set((state) => ({
      selectedFilePaths: new Set(),
      selectionModel:
        state.selectionModel?.mode === 'explicit'
          ? resolveSelectionModelAfterExplicitMutation(state.selectionModel, new Set<string>())
          : createExplicitSelectionModel(new Set<string>()),
      querySelectionManifest: null,
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  addMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    logger.debug('addMultipleSelectedFiles called', {
      folderId,
      pathCount: paths.length,
      samplePaths: paths.slice(0, 3),
    });

    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          state,
          folderId,
          additions: paths,
          removals: [],
        });
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const previousSize = newSelectedFiles.size;
      let currentSize = previousSize;

      for (const path of paths) {
        if (currentSize >= state.maxSelectionCount) {
          break; // Stop if max selection count is reached
        }
        const compositeKey = encodeFileSelection(folderId, path);
        if (!newSelectedFiles.has(compositeKey)) {
          newSelectedFiles.add(compositeKey);
          currentSize++;
        }
      }

      logger.debug('addMultipleSelectedFiles complete', {
        previousSize,
        newSize: newSelectedFiles.size,
        addedCount: newSelectedFiles.size - previousSize,
        sampleKeys: [...newSelectedFiles].slice(0, 3),
      });

      return {
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        querySelectionManifest: null,
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    set((state) => {
      if (state.selectionModel.mode === 'query') {
        return applyQuerySelectionMutation({
          state,
          folderId,
          additions: [],
          removals: paths,
        });
      }
      const newSelectedFiles = new Set(state.selectedFilePaths);
      for (const path of paths) {
        const compositeKey = encodeFileSelection(folderId, path);
        newSelectedFiles.delete(compositeKey);
      }
      return {
        selectedFilePaths: newSelectedFiles,
        selectionModel: resolveSelectionModelAfterExplicitMutation(
          state.selectionModel,
          newSelectedFiles
        ),
        querySelectionManifest: null,
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
      folderId,
      pathCount: paths.length,
      chunkSize,
    });

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

        for (const path of paths) {
          if (currentSize >= state.maxSelectionCount) {
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
          selectedFilePaths: newSelectedFiles,
          selectionModel: resolveSelectionModelAfterExplicitMutation(
            state.selectionModel,
            newSelectedFiles
          ),
          querySelectionManifest: null,
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

        for (const compositeKey of computedKeys) {
          if (currentSize >= state.maxSelectionCount) {
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
          selectedFilePaths: newSelectedFiles,
          selectionModel: resolveSelectionModelAfterExplicitMutation(
            state.selectionModel,
            newSelectedFiles
          ),
          querySelectionManifest: null,
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
});
