import type {
  FileExplorerState,
  FolderState,
  SelectionModel,
  SerializedSelectionModel,
  SerializedState,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
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

/**
 * Serialize SelectionModel for persistence (Sets → Arrays).
 */
function serializeSelectionModel(model: SelectionModel): SerializedSelectionModel {
  return {
    mode: model.mode,
    explicitPaths: cachedSetToArray(model.explicitPaths),
    ruleSetJson: model.ruleSetJson,
    materializedPaths: model.materializedPaths ? cachedSetToArray(model.materializedPaths) : null,
    materializedAt: model.materializedAt,
  };
}

/**
 * Deserialize SelectionModel from persistence (Arrays → Sets).
 */
function deserializeSelectionModel(
  serialized: SerializedSelectionModel | undefined
): SelectionModel {
  if (!serialized) {
    return createEmptySelectionModel();
  }

  return {
    mode: serialized.mode === 'rules' ? 'rules' : 'explicit',
    explicitPaths: new Set(coerceStringArray(serialized.explicitPaths)),
    ruleSetJson: serialized.ruleSetJson ?? null,
    materializedPaths: serialized.materializedPaths
      ? new Set(coerceStringArray(serialized.materializedPaths))
      : null,
    materializedAt: serialized.materializedAt ?? null,
  };
}

export function serializeState(state: FileExplorerState): SerializedState {
  // CRITICAL: Before serializing, ensure the current folder's state includes the
  // top-level selectedFilePaths and expandedDirectoryPaths. This prevents data loss
  // when the user closes the app without switching folders - the top-level state
  // has the latest selections, but folderStates[currentFolderId] might be stale.
  const currentFolderId = state.currentFolderId;
  const folderStatesToSerialize = { ...state.folderStates };

  if (currentFolderId && folderStatesToSerialize[currentFolderId]) {
    // Sync current top-level state into the current folder's state
    folderStatesToSerialize[currentFolderId] = {
      ...folderStatesToSerialize[currentFolderId],
      selectedFilePaths: state.selectedFilePaths,
      expandedDirectoryPaths: state.expandedDirectoryPaths,
      includeFilters: state.includeFilters,
      excludeFilters: state.excludeFilters,
      useRegex: state.useRegex,
      includeProjectTree: state.includeProjectTree,
      tokenBudget: state.tokenBudget,
      folderSummaryThreshold: state.folderSummaryThreshold,
      maxSelectionCount: state.maxSelectionCount,
      lastActiveTab: state.lastActiveTab ?? 'files',
      lastAccessed: Date.now(),
      viewFilterPresetId: state.viewFilterPresetId,
    };
  } else if (currentFolderId && !folderStatesToSerialize[currentFolderId]) {
    // Create folder state if it doesn't exist yet
    folderStatesToSerialize[currentFolderId] = {
      selectedFilePaths: state.selectedFilePaths,
      expandedDirectoryPaths: state.expandedDirectoryPaths,
      includeFilters: state.includeFilters,
      excludeFilters: state.excludeFilters,
      useRegex: state.useRegex,
      includeProjectTree: state.includeProjectTree,
      tokenBudget: state.tokenBudget,
      folderSummaryThreshold: state.folderSummaryThreshold,
      maxSelectionCount: state.maxSelectionCount,
      lastActiveTab: state.lastActiveTab ?? 'files',
      lastAccessed: Date.now(),
      viewFilterPresetId: state.viewFilterPresetId,
    };
  }

  const serialized: SerializedState = {
    currentFolderId: state.currentFolderId,
    folderStates: Object.fromEntries(
      Object.entries(folderStatesToSerialize || {}).map(([id, folderState]) => [
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
    selectionModel: serializeSelectionModel(state.selectionModel),
    viewFilterPresetId: state.viewFilterPresetId,
    isFiltersExpanded: state.isFiltersExpanded,
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

  // Parse top-level state first so we can use it for folder state sync
  const topLevelSelectedFilePaths = new Set(
    coerceStringArray(persistedSerialized.selectedFilePaths)
  );
  const topLevelExpandedDirectoryPaths = new Set(
    coerceStringArray(persistedSerialized.expandedDirectoryPaths)
  );
  const currentFolderId = persistedSerialized.currentFolderId;

  const mergedState: FileExplorerState = {
    ...current,
    ...persistedSerialized,
    selectedFilePaths: topLevelSelectedFilePaths,
    expandedDirectoryPaths: topLevelExpandedDirectoryPaths,
    folderAccessOrder: coerceStringArray(persistedSerialized.folderAccessOrder),
    folderStates: Object.fromEntries(
      Object.entries(persistedSerialized.folderStates ?? {}).map(([key, psFolderState]) => {
        const currentFolderState = current.folderStates[key];
        const fallbackTokenBudget = currentFolderState?.tokenBudget ?? current.tokenBudget;

        // CRITICAL: For the current folder, if the folderState has empty selections but
        // the top-level state has selections, prefer the top-level state. This handles
        // the case where the app was closed without switching folders - the top-level
        // state was saved correctly but folderStates[currentFolderId] was stale.
        const isCurrentFolder = key === currentFolderId;
        const folderHasEmptySelections =
          coerceStringArray(psFolderState.selectedFilePaths).length === 0;
        const topLevelHasSelections = topLevelSelectedFilePaths.size > 0;
        const shouldUseTopLevelSelections =
          isCurrentFolder && folderHasEmptySelections && topLevelHasSelections;

        const folderHasEmptyExpansions =
          coerceStringArray(psFolderState.expandedDirectoryPaths).length === 0;
        const topLevelHasExpansions = topLevelExpandedDirectoryPaths.size > 0;
        const shouldUseTopLevelExpansions =
          isCurrentFolder && folderHasEmptyExpansions && topLevelHasExpansions;

        return [
          key,
          {
            ...(currentFolderState ?? ({} as FolderState)),
            ...psFolderState,
            selectedFilePaths: shouldUseTopLevelSelections
              ? topLevelSelectedFilePaths
              : new Set(coerceStringArray(psFolderState.selectedFilePaths)),
            expandedDirectoryPaths: shouldUseTopLevelExpansions
              ? topLevelExpandedDirectoryPaths
              : new Set(coerceStringArray(psFolderState.expandedDirectoryPaths)),
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
    selectionModel: deserializeSelectionModel(persistedSerialized.selectionModel),
    isFiltersExpanded: coerceBoolean(
      persistedSerialized.isFiltersExpanded,
      current.isFiltersExpanded
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
