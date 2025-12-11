import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('Persistence');

/**
 * Cached Set-to-Array converter using WeakMap.
 * Only runs Array.from() when the Set reference changes.
 * This is critical for performance with large Sets (17k+ items).
 */
const setArrayCache = new WeakMap<Set<string>, string[]>();

function cachedSetToArray(set: Set<string> | undefined): string[] {
  if (!set || set.size === 0) {
    return [];
  }

  let cached = setArrayCache.get(set);
  if (!cached) {
    cached = Array.from(set);
    setArrayCache.set(set, cached);
  }
  return cached;
}

export function serializeState(state: FileExplorerState): SerializedState {
  const serialized: SerializedState = {
    currentFolderId: state.currentFolderId,
    folderStates: Object.fromEntries(
      Object.entries(state.folderStates || {}).map(([id, folderState]) => [
        id,
        {
          ...folderState,
          selectedFilePaths: cachedSetToArray(folderState?.selectedFilePaths),
          expandedDirectoryPaths: cachedSetToArray(folderState?.expandedDirectoryPaths),
          lastAccessed: folderState?.lastAccessed || Date.now(),
        },
      ])
    ),
    folderAccessOrder: state.folderAccessOrder,
    selectedFilePaths: cachedSetToArray(state.selectedFilePaths),
    expandedDirectoryPaths: cachedSetToArray(state.expandedDirectoryPaths),
    includeFilters: state.includeFilters,
    excludeFilters: state.excludeFilters,
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastActiveTab: state.lastActiveTab ?? 'files',
    quickFilter: state.quickFilter,
    devInlineFixtureEnabled: state.devInlineFixtureEnabled,
  };

  return serialized;
}

export function mergeState(
  persisted: SerializedState | null | undefined,
  current: FileExplorerState,
  shouldLog: boolean
): FileExplorerState {
  if (shouldLog) {
    // Log summary only to avoid DevTools serialization issues with large objects
    logger.debug(
      'Merge - Persisted folder count:',
      Object.keys(persisted?.folderStates ?? {}).length,
      'Current folder count:',
      Object.keys(current.folderStates).length
    );
  }
  if (!persisted) {
    if (shouldLog) {
      logger.debug('Merge - No persisted state, returning current initial state.');
    }
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
    devInlineFixtureEnabled:
      typeof persistedSerialized.devInlineFixtureEnabled === 'boolean'
        ? persistedSerialized.devInlineFixtureEnabled
        : current.devInlineFixtureEnabled,
  };

  for (const key in current.folderStates) {
    if (!mergedState.folderStates[key]) {
      mergedState.folderStates[key] = current.folderStates[key] as FolderState;
    }
  }

  if (shouldLog) {
    // Log summary only to avoid DevTools serialization issues
    logger.debug(
      'Merge complete - Total folders:',
      Object.keys(mergedState.folderStates).length,
      'Current folder ID:',
      mergedState.currentFolderId
    );
  }
  return mergedState;
}
