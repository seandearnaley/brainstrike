import type { FileExplorerState } from '@brainstrike/types';
import { createLogger, encodeFileSelection } from '@brainstrike/utils';
import {
  DEFAULT_SELECTION_CHUNK_SIZE,
  IDLE_CALLBACK_TIMEOUT_MS,
} from '../constants/selection-constants';
import type { GetState, SetState } from '../types/store-types';

const logger = createLogger('FileSelectionActions');

export interface ChunkedSelectionOptions {
  /** Number of files to process per chunk (default: DEFAULT_SELECTION_CHUNK_SIZE = 100) */
  chunkSize?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Callback for progress updates (filesProcessed, totalFiles) */
  onProgress?: (processed: number, total: number) => void;
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
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
  addSelectedFile: (folderId: string | null, path: string) => void;
  removeSelectedFile: (folderId: string | null, path: string) => void;
  toggleSelectedFile: (folderId: string | null, path: string) => void;
  clearSelectedFiles: () => void;
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
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
}

/** Schedule work during browser idle time with error handling. */
function scheduleChunk(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scheduleCallback =
      typeof requestIdleCallback !== 'undefined'
        ? (cb: () => void) =>
            requestIdleCallback(
              () => {
                try {
                  cb();
                } catch (error) {
                  reject(error);
                }
              },
              { timeout: IDLE_CALLBACK_TIMEOUT_MS }
            )
        : (cb: () => void) =>
            setTimeout(() => {
              try {
                cb();
              } catch (error) {
                reject(error);
              }
            }, 0);

    scheduleCallback(resolve);
  });
}

interface ComputeKeysResult {
  computedKeys: string[];
  processedCount: number;
  cancelled: boolean;
  wasCapped: boolean;
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
  signal?: AbortSignal,
  onProgress?: (processed: number, total: number) => void
): Promise<ComputeKeysResult> {
  const cappedPaths = remainingBudget < paths.length ? paths.slice(0, remainingBudget) : paths;
  const computedKeys: string[] = [];
  let processedCount = 0;
  let cancelled = false;

  while (processedCount < cappedPaths.length && !cancelled) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    await scheduleChunk();

    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    const chunkEnd = Math.min(processedCount + chunkSize, cappedPaths.length);
    for (let i = processedCount; i < chunkEnd; i++) {
      const path = cappedPaths[i];
      if (path !== undefined) {
        computedKeys.push(encodeFileSelection(folderId, path));
      }
    }

    processedCount = chunkEnd;
    onProgress?.(processedCount, paths.length);
  }

  return {
    computedKeys,
    processedCount,
    cancelled,
    wasCapped: cappedPaths.length < paths.length,
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
      // Only add files that are already in composite key format
      if (file.includes('|@|')) {
        validatedFiles.add(file);
      }
    }
    set((state) => ({
      selectedFilePaths: validatedFiles,
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  addSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      // Check against maxSelectionCount before adding
      if (newSelectedFiles.size < state.maxSelectionCount) {
        newSelectedFiles.add(encodeFileSelection(folderId, path));
      }
      return {
        selectedFilePaths: newSelectedFiles,
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  removeSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      newSelectedFiles.delete(encodeFileSelection(folderId, path));
      return {
        selectedFilePaths: newSelectedFiles,
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  toggleSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
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
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  clearSelectedFiles: () => {
    set((state) => ({
      selectedFilePaths: new Set(),
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
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },

  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      for (const path of paths) {
        const compositeKey = encodeFileSelection(folderId, path);
        newSelectedFiles.delete(compositeKey);
      }
      return {
        selectedFilePaths: newSelectedFiles,
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
      const sizeBefore = stateBefore.selectedFilePaths.size;

      set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        let currentSize = newSelectedFiles.size;

        for (const path of paths) {
          if (currentSize >= state.maxSelectionCount) {
            break;
          }
          const compositeKey = encodeFileSelection(folderId, path);
          if (!newSelectedFiles.has(compositeKey)) {
            newSelectedFiles.add(compositeKey);
            currentSize++;
          }
        }

        return {
          selectedFilePaths: newSelectedFiles,
          selectionVersion: state.selectionVersion + 1,
        };
      });

      const stateAfter = get();
      const addedCount = stateAfter.selectedFilePaths.size - sizeBefore;
      const limitReached = stateAfter.selectedFilePaths.size >= stateAfter.maxSelectionCount;

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
    const remainingBudget = Math.max(
      0,
      currentState.maxSelectionCount - currentState.selectedFilePaths.size
    );

    const { computedKeys, processedCount, cancelled, wasCapped } = await computeKeysInChunks(
      folderId,
      paths,
      remainingBudget,
      chunkSize,
      signal,
      onProgress
    );

    // Phase 2: Single atomic state update with all computed keys
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
