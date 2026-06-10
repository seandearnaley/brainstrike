import type {
  FileExplorerData,
  FileExplorerState,
  FolderState,
  SelectionModel,
  SerializedSelectionModel,
  SerializedState,
  StoredRootDescriptor,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('Persistence');
const MAX_PERSISTED_STRING_ARRAY_LENGTH = 50_000;

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

  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length <= MAX_PERSISTED_STRING_ARRAY_LENGTH) {
    return strings;
  }

  logger.warn('Truncating oversized persisted string array', {
    maxEntries: MAX_PERSISTED_STRING_ARRAY_LENGTH,
    receivedEntries: strings.length,
  });
  return strings.slice(0, MAX_PERSISTED_STRING_ARRAY_LENGTH);
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Validate and coerce a persisted StoredRootDescriptor entry.
 * Returns null if the value is malformed (missing required string fields).
 */
function coerceStoredRootDescriptor(value: unknown): StoredRootDescriptor | null {
  if (!(value && typeof value === 'object')) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v['rootId'] !== 'string' ||
    typeof v['displayName'] !== 'string' ||
    typeof v['path'] !== 'string'
  ) {
    return null;
  }
  return {
    rootId: v['rootId'],
    displayName: v['displayName'],
    path: v['path'],
  };
}

/**
 * Coerce a persisted rootDescriptors map — drop any malformed entries.
 */
function coerceRootDescriptors(
  value: unknown,
  fallback: Record<string, StoredRootDescriptor>
): Record<string, StoredRootDescriptor> {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return fallback;
  }
  const result: Record<string, StoredRootDescriptor> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const coerced = coerceStoredRootDescriptor(entry);
    if (coerced) {
      result[key] = coerced;
    } else {
      logger.debug('coerceRootDescriptors: dropping malformed entry', { key });
    }
  }
  return result;
}

/**
 * Coerce both multi-root fields together so the invariant "every id in
 * activeRootIds has a descriptor" holds as a postcondition — coercion can drop
 * a malformed descriptor whose id would otherwise dangle in the array.
 */
function mergeActiveRoots(
  persistedSerialized: { activeRootIds?: unknown; rootDescriptors?: unknown },
  current: { rootDescriptors: Record<string, StoredRootDescriptor> }
): Pick<FileExplorerData, 'activeRootIds' | 'rootDescriptors'> {
  const rootDescriptors = coerceRootDescriptors(
    persistedSerialized.rootDescriptors,
    current.rootDescriptors
  );
  const activeRootIds = coerceStringArray(persistedSerialized.activeRootIds).filter(
    (id) => id in rootDescriptors
  );
  return { activeRootIds, rootDescriptors };
}

function deserializeQueryDescriptor(value: unknown): SerializedSelectionModel['queryDescriptor'] {
  if (!(value && typeof value === 'object')) {
    return null;
  }

  const descriptor = value as Record<string, unknown>;
  const kind =
    descriptor['kind'] === 'recursive-folder' || descriptor['kind'] === 'recursive-select-all'
      ? descriptor['kind']
      : null;
  const folderId = typeof descriptor['folderId'] === 'string' ? descriptor['folderId'] : null;

  if (!(kind && folderId)) {
    return null;
  }

  return {
    kind,
    folderId,
    rootPath: typeof descriptor['rootPath'] === 'string' ? descriptor['rootPath'] : null,
    coveredDirectoryPaths: coerceStringArray(descriptor['coveredDirectoryPaths']),
    includeFilters: coerceStringArray(descriptor['includeFilters']),
    excludeFilters: coerceStringArray(descriptor['excludeFilters']),
    includedPaths: coerceStringArray(descriptor['includedPaths']),
    excludedPaths: coerceStringArray(descriptor['excludedPaths']),
    manifestFingerprint: coerceNullableString(descriptor['manifestFingerprint']),
    manifestSnapshotId: coerceNullableString(descriptor['manifestSnapshotId']),
    useRegex: coerceBoolean(descriptor['useRegex'], false),
    totalSelectedCount: Math.max(0, coerceNumber(descriptor['totalSelectedCount'], 0)),
  };
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
    queryDescriptor: model.queryDescriptor,
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

  const queryDescriptor = deserializeQueryDescriptor(serialized.queryDescriptor);
  const shouldWarnOnMalformedQueryDescriptor =
    serialized.mode === 'query' && serialized.queryDescriptor !== null && !queryDescriptor;

  if (shouldWarnOnMalformedQueryDescriptor) {
    logger.warn('Dropping malformed persisted query selection descriptor during deserialization');
  }
  const mode =
    serialized.mode === 'rules'
      ? 'rules'
      : serialized.mode === 'query' && queryDescriptor
        ? 'query'
        : 'explicit';

  return {
    mode,
    explicitPaths: new Set(coerceStringArray(serialized.explicitPaths)),
    ruleSetJson: serialized.ruleSetJson ?? null,
    materializedPaths: serialized.materializedPaths
      ? new Set(coerceStringArray(serialized.materializedPaths))
      : null,
    materializedAt: serialized.materializedAt ?? null,
    queryDescriptor,
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
      selectionModel: state.selectionModel,
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
      selectionModel: state.selectionModel,
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
    activeRootIds: state.activeRootIds,
    rootDescriptors: state.rootDescriptors,
    currentFolderId: state.currentFolderId,
    folderStates: Object.fromEntries(
      Object.entries(folderStatesToSerialize || {}).map(([id, folderState]) => [
        id,
        {
          ...folderState,
          selectedFilePaths: cachedSetToArray(folderState?.selectedFilePaths),
          selectionModel: serializeSelectionModel(
            folderState?.selectionModel ?? createEmptySelectionModel()
          ),
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
  const topLevelSelectionModel = deserializeSelectionModel(persistedSerialized.selectionModel);
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
        const topLevelHasCanonicalSelectionModel = topLevelSelectionModel.mode !== 'explicit';
        const shouldUseTopLevelSelections =
          isCurrentFolder &&
          folderHasEmptySelections &&
          (topLevelHasSelections || topLevelHasCanonicalSelectionModel);

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
            selectionModel:
              shouldUseTopLevelSelections && persistedSerialized.selectionModel
                ? topLevelSelectionModel
                : deserializeSelectionModel(psFolderState.selectionModel),
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
    selectionModel: topLevelSelectionModel,
    isFiltersExpanded: coerceBoolean(
      persistedSerialized.isFiltersExpanded,
      current.isFiltersExpanded
    ),
    // Multi-root (Phase 4) fields — coerced safely from persisted data
    ...mergeActiveRoots(persistedSerialized, current),
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
