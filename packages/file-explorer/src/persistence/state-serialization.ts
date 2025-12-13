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

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
    tokenBudget: state.tokenBudget,
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
    selectedFilePaths: new Set(coerceStringArray(persistedSerialized.selectedFilePaths)),
    expandedDirectoryPaths: new Set(coerceStringArray(persistedSerialized.expandedDirectoryPaths)),
    folderAccessOrder: coerceStringArray(persistedSerialized.folderAccessOrder),
    folderStates: Object.fromEntries(
      Object.entries(persistedSerialized.folderStates ?? {}).map(([key, psFolderState]) => {
        const currentFolderState = current.folderStates[key];
        const fallbackTokenBudget = currentFolderState?.tokenBudget ?? current.tokenBudget;
        return [
          key,
          {
            ...(currentFolderState ?? ({} as FolderState)),
            ...psFolderState,
            selectedFilePaths: new Set(coerceStringArray(psFolderState.selectedFilePaths)),
            expandedDirectoryPaths: new Set(
              coerceStringArray(psFolderState.expandedDirectoryPaths)
            ),
            tokenBudget: coerceNumber(psFolderState.tokenBudget, fallbackTokenBudget),
          },
        ];
      })
    ),
    tokenBudget: coerceNumber(persistedSerialized.tokenBudget, current.tokenBudget),
    quickFilter: coerceString(persistedSerialized.quickFilter, current.quickFilter),
    devInlineFixtureEnabled: coerceBoolean(
      persistedSerialized.devInlineFixtureEnabled,
      current.devInlineFixtureEnabled
    ),
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
