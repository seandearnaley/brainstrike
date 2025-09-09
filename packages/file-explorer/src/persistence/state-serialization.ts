import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('Persistence');

export function serializeState(state: FileExplorerState): SerializedState {
  const serialized: SerializedState = {
    currentFolderId: state.currentFolderId,
    folderStates: Object.fromEntries(
      Object.entries(state.folderStates || {}).map(([id, folderState]) => [
        id,
        {
          ...folderState,
          selectedFilePaths: Array.from(folderState?.selectedFilePaths || new Set<string>()),
          expandedDirectoryPaths: Array.from(
            folderState?.expandedDirectoryPaths || new Set<string>()
          ),
          lastAccessed: folderState?.lastAccessed || Date.now(),
        },
      ])
    ),
    folderAccessOrder: state.folderAccessOrder,
    selectedFilePaths: Array.from(state.selectedFilePaths || new Set<string>()),
    expandedDirectoryPaths: Array.from(state.expandedDirectoryPaths || new Set<string>()),
    includeFilters: state.includeFilters,
    excludeFilters: state.excludeFilters,
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastActiveTab: state.lastActiveTab ?? 'files',
    quickFilter: state.quickFilter,
  };

  return serialized;
}

export function mergeState(
  persisted: SerializedState | null | undefined,
  current: FileExplorerState,
  shouldLog: boolean
): FileExplorerState {
  if (shouldLog)
    logger.debug(
      'Merge - Persisted (SerializedState from migrate):',
      persisted,
      'Current (FileExplorerState from initial):',
      current
    );
  if (!persisted) {
    if (shouldLog) logger.debug('Merge - No persisted state, returning current initial state.');
    return current;
  }

  const persistedSerialized = persisted as SerializedState;

  const mergedState: FileExplorerState = {
    ...current,
    ...persistedSerialized,
    selectedFilePaths: new Set(
      Array.isArray(persistedSerialized.selectedFilePaths)
        ? persistedSerialized.selectedFilePaths
        : []
    ),
    expandedDirectoryPaths: new Set(
      Array.isArray(persistedSerialized.expandedDirectoryPaths)
        ? persistedSerialized.expandedDirectoryPaths
        : []
    ),
    folderAccessOrder: Array.isArray(persistedSerialized.folderAccessOrder)
      ? persistedSerialized.folderAccessOrder
      : [],
    folderStates: Object.fromEntries(
      Object.entries(persistedSerialized.folderStates ?? {}).map(([key, psFolderState]) => {
        const currentFolderState = current.folderStates[key];
        return [
          key,
          {
            ...(currentFolderState ?? ({} as FolderState)),
            ...psFolderState,
            selectedFilePaths: new Set(
              Array.isArray(psFolderState.selectedFilePaths) ? psFolderState.selectedFilePaths : []
            ),
            expandedDirectoryPaths: new Set(
              Array.isArray(psFolderState.expandedDirectoryPaths)
                ? psFolderState.expandedDirectoryPaths
                : []
            ),
          },
        ];
      })
    ),
    quickFilter:
      typeof persistedSerialized.quickFilter === 'string'
        ? persistedSerialized.quickFilter
        : current.quickFilter,
  };

  for (const key in current.folderStates) {
    if (!mergedState.folderStates[key]) {
      mergedState.folderStates[key] = current.folderStates[key] as FolderState;
    }
  }

  if (shouldLog)
    logger.debug('Merge - Resulting merged FileExplorerState (with Sets):', mergedState);
  return mergedState;
}
