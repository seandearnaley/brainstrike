import { useDatabaseFileLoading } from '@brainstrike/file-explorer-hooks';
import type { DatabaseProgressState, LoadingProgressState } from './database-loading-overlay';

export interface CombinedLoadingState {
  /** Overall loading state */
  isLoading: boolean;

  /** File tree specific loading */
  isFileTreeLoading: boolean;
  fileTreeProgressState?: LoadingProgressState | undefined;

  /** Database population specific loading */
  isDatabasePopulating: boolean;
  databaseProgressState?: DatabaseProgressState | undefined;

  /** Combined loading type for UI decisions */
  loadingType: 'none' | 'file-tree' | 'database' | 'both';

  /** Cancellation support */
  canCancel: boolean;
  onCancel?: (() => void) | undefined;
}

/**
 * Hook that combines file tree loading and database population progress
 * into a single loading state for the UI
 *
 * Note: This hook is designed to be used alongside useFileExplorer
 * which provides the file tree loading state
 */
export function useCombinedLoading(
  fileTreeLoading?:
    | {
        isLoading: boolean;
        loadingProgress?: LoadingProgressState | undefined;
        cancellable?: boolean | undefined;
        onCancel?: (() => void) | undefined;
      }
    | undefined
): CombinedLoadingState {
  // Get database loading state
  const { populationProgress } = useDatabaseFileLoading();

  // Extract file tree loading information from parameters
  const isFileTreeLoading = fileTreeLoading?.isLoading || false;
  const fileTreeProgressState: LoadingProgressState | undefined = fileTreeLoading?.loadingProgress;

  // Extract database population information
  const isDatabasePopulating = populationProgress?.isLoading || false;
  const databaseProgressState: DatabaseProgressState | undefined = populationProgress
    ? {
        loaded: populationProgress.loaded,
        total: populationProgress.total,
        isLoading: populationProgress.isLoading,
      }
    : undefined;

  // Determine overall loading state
  const isLoading = isFileTreeLoading || isDatabasePopulating;

  // Determine loading type
  let loadingType: CombinedLoadingState['loadingType'] = 'none';
  if (isDatabasePopulating && isFileTreeLoading) {
    loadingType = 'both';
  } else if (isDatabasePopulating) {
    loadingType = 'database';
  } else if (isFileTreeLoading) {
    loadingType = 'file-tree';
  }

  // Cancellation support - only allow cancellation for file tree loading for now
  const canCancel =
    isFileTreeLoading && !!(fileTreeLoading?.cancellable && fileTreeLoading?.onCancel);
  const onCancel = canCancel ? fileTreeLoading?.onCancel : undefined;

  return {
    isLoading,
    isFileTreeLoading,
    fileTreeProgressState,
    isDatabasePopulating,
    databaseProgressState,
    loadingType,
    canCancel,
    onCancel,
  };
}

/**
 * Hook that provides database-specific loading state
 * Useful for components that only need to show database population progress
 */
export function useDatabaseLoadingState() {
  const combinedState = useCombinedLoading();

  return {
    isDatabasePopulating: combinedState.isDatabasePopulating,
    databaseProgressState: combinedState.databaseProgressState,
    isLoading: combinedState.isDatabasePopulating,
  };
}

/**
 * Hook that provides file tree-specific loading state
 * Useful for components that only need to show file tree loading progress
 */
export function useFileTreeLoadingState() {
  const combinedState = useCombinedLoading();

  return {
    isFileTreeLoading: combinedState.isFileTreeLoading,
    fileTreeProgressState: combinedState.fileTreeProgressState,
    isLoading: combinedState.isFileTreeLoading,
    canCancel: combinedState.canCancel,
    onCancel: combinedState.onCancel,
  };
}
