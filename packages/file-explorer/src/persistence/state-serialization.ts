import { createLogger } from '@brainstrike/logging';
import type {
  FileExplorerData,
  FileExplorerState,
  FolderState,
  SelectionModel,
  SerializedSelectionModel,
  SerializedState,
  StoredRootDescriptor,
} from '@brainstrike/types';
import {
  createEmptySelectionModel,
  DEFAULT_MAX_SELECTION_COUNT,
  LEGACY_DEFAULT_MAX_SELECTION_COUNT,
} from '@brainstrike/types';
import { decodeFileSelection } from '../selection.js';

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

function deserializeSelectionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid persisted selection key collection');
  }

  const boundedValue =
    value.length <= MAX_PERSISTED_STRING_ARRAY_LENGTH
      ? value
      : value.slice(0, MAX_PERSISTED_STRING_ARRAY_LENGTH);
  if (boundedValue.length !== value.length) {
    logger.warn('Truncating oversized persisted selection key array', {
      maxEntries: MAX_PERSISTED_STRING_ARRAY_LENGTH,
      receivedEntries: value.length,
    });
  }

  const keys: string[] = [];
  for (const key of boundedValue) {
    if (typeof key !== 'string') {
      throw new Error('Invalid composite key format');
    }
    decodeFileSelection(key);
    keys.push(key);
  }
  return keys;
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
    displayName: v['displayName'],
    path: v['path'],
    rootId: v['rootId'],
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
      logger.debug('coerceRootDescriptors: dropping malformed entry');
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
    coveredDirectoryPaths: coerceStringArray(descriptor['coveredDirectoryPaths']),
    excludedPaths: coerceStringArray(descriptor['excludedPaths']),
    excludeFilters: coerceStringArray(descriptor['excludeFilters']),
    folderId,
    includedPaths: coerceStringArray(descriptor['includedPaths']),
    includeFilters: coerceStringArray(descriptor['includeFilters']),
    kind,
    manifestFingerprint: coerceNullableString(descriptor['manifestFingerprint']),
    manifestSnapshotId: coerceNullableString(descriptor['manifestSnapshotId']),
    rootPath: typeof descriptor['rootPath'] === 'string' ? descriptor['rootPath'] : null,
    totalSelectedCount: Math.max(0, coerceNumber(descriptor['totalSelectedCount'], 0)),
    useRegex: coerceBoolean(descriptor['useRegex'], false),
  };
}

/**
 * Serialize SelectionModel for persistence (Sets → Arrays).
 */
function serializeSelectionModel(model: SelectionModel): SerializedSelectionModel {
  return {
    explicitPaths: cachedSetToArray(model.explicitPaths),
    materializedAt: model.materializedAt,
    materializedPaths: model.materializedPaths ? cachedSetToArray(model.materializedPaths) : null,
    mode: model.mode,
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
  // Legacy migration: profiles persisted before the rules-based selection
  // feature was removed can carry mode 'rules'. Rules mode always synced its
  // materialized selection into selectedFilePaths at save time, so degrading
  // the model to explicit preserves the user's effective selection.
  if ((serialized as { mode?: unknown }).mode === 'rules') {
    logger.warn(
      'Persisted selection model uses removed rules mode; migrating to explicit selection'
    );
  }
  const mode = serialized.mode === 'query' && queryDescriptor ? 'query' : 'explicit';

  // The materialized-path cache (and its timestamp) is a query-mode display
  // artifact — nothing in explicit mode reads it. Drop it whenever we resolve
  // to explicit so migrated legacy 'rules' profiles (and any stray explicit
  // model that carried a cache) converge to a clean explicit shape instead of
  // re-persisting dead data on every save.
  const isQueryMode = mode === 'query';

  return {
    explicitPaths: new Set(deserializeSelectionKeys(serialized.explicitPaths ?? [])),
    materializedAt: isQueryMode ? (serialized.materializedAt ?? null) : null,
    materializedPaths:
      isQueryMode && serialized.materializedPaths
        ? new Set(coerceStringArray(serialized.materializedPaths))
        : null,
    mode,
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
      excludeFilters: state.excludeFilters,
      expandedDirectoryPaths: state.expandedDirectoryPaths,
      folderSummaryThreshold: state.folderSummaryThreshold,
      includeFilters: state.includeFilters,
      includeProjectTree: state.includeProjectTree,
      lastAccessed: Date.now(),
      lastActiveTab: state.lastActiveTab ?? 'files',
      maxSelectionCount: state.maxSelectionCount,
      selectedFilePaths: state.selectedFilePaths,
      selectionModel: state.selectionModel,
      useRegex: state.useRegex,
      viewFilterPresetId: state.viewFilterPresetId,
    };
  } else if (currentFolderId && !folderStatesToSerialize[currentFolderId]) {
    // Create folder state if it doesn't exist yet
    folderStatesToSerialize[currentFolderId] = {
      excludeFilters: state.excludeFilters,
      expandedDirectoryPaths: state.expandedDirectoryPaths,
      folderSummaryThreshold: state.folderSummaryThreshold,
      includeFilters: state.includeFilters,
      includeProjectTree: state.includeProjectTree,
      lastAccessed: Date.now(),
      lastActiveTab: state.lastActiveTab ?? 'files',
      maxSelectionCount: state.maxSelectionCount,
      selectedFilePaths: state.selectedFilePaths,
      selectionModel: state.selectionModel,
      useRegex: state.useRegex,
      viewFilterPresetId: state.viewFilterPresetId,
    };
  }

  const serialized: SerializedState = {
    activeRootIds: state.activeRootIds,
    currentFolderId: state.currentFolderId,
    devInlineFixtureEnabled: state.devInlineFixtureEnabled,
    excludeFilters: state.excludeFilters,
    expandedDirectoryPaths: cachedSetToArray(state.expandedDirectoryPaths),
    explorerScrollTop: state.explorerScrollTop,
    folderAccessOrder: state.folderAccessOrder,
    folderStates: Object.fromEntries(
      Object.entries(folderStatesToSerialize || {}).map(([id, folderState]) => [
        id,
        {
          ...folderState,
          expandedDirectoryPaths: cachedSetToArray(folderState?.expandedDirectoryPaths),
          lastAccessed: folderState?.lastAccessed || Date.now(),
          selectedFilePaths: cachedSetToArray(folderState?.selectedFilePaths),
          selectionModel: serializeSelectionModel(
            folderState?.selectionModel ?? createEmptySelectionModel()
          ),
        },
      ])
    ),
    folderSummaryThreshold: state.folderSummaryThreshold,
    includeFilters: state.includeFilters,
    includeProjectTree: state.includeProjectTree,
    isFilterChipsVisible: state.isFilterChipsVisible,
    isFiltersExpanded: state.isFiltersExpanded,
    lastActiveTab: state.lastActiveTab ?? 'files',
    maxSelectionCount: state.maxSelectionCount,
    quickFilter: state.quickFilter,
    rootDescriptors: state.rootDescriptors,
    selectedFilePaths: cachedSetToArray(state.selectedFilePaths),
    selectionModel: serializeSelectionModel(state.selectionModel),
    useRegex: state.useRegex,
    viewFilterPresetId: state.viewFilterPresetId,
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
    deserializeSelectionKeys(persistedSerialized.selectedFilePaths)
  );
  const topLevelExpandedDirectoryPaths = new Set(
    coerceStringArray(persistedSerialized.expandedDirectoryPaths)
  );
  const topLevelSelectionModel = deserializeSelectionModel(persistedSerialized.selectionModel);
  const currentFolderId = persistedSerialized.currentFolderId;

  const mergedState: FileExplorerState = {
    ...current,
    ...persistedSerialized,
    devInlineFixtureEnabled: coerceBoolean(
      persistedSerialized.devInlineFixtureEnabled,
      current.devInlineFixtureEnabled
    ),
    expandedDirectoryPaths: topLevelExpandedDirectoryPaths,
    // Coerce over the raw spread: an older snapshot omits it (→ current default
    // 0) and a corrupt non-number must not reach the DOM scroll setter.
    explorerScrollTop: Math.max(
      0,
      coerceNumber(persistedSerialized.explorerScrollTop, current.explorerScrollTop)
    ),
    folderAccessOrder: coerceStringArray(persistedSerialized.folderAccessOrder),
    folderStates: Object.fromEntries(
      Object.entries(persistedSerialized.folderStates ?? {}).map(([key, psFolderState]) => {
        const currentFolderState = current.folderStates[key];
        // CRITICAL: For the current folder, if the folderState has empty selections but
        // the top-level state has selections, prefer the top-level state. This handles
        // the case where the app was closed without switching folders - the top-level
        // state was saved correctly but folderStates[currentFolderId] was stale.
        const isCurrentFolder = key === currentFolderId;
        const folderSelectionKeys = deserializeSelectionKeys(psFolderState.selectedFilePaths ?? []);
        const folderHasEmptySelections = folderSelectionKeys.length === 0;
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
            expandedDirectoryPaths: shouldUseTopLevelExpansions
              ? topLevelExpandedDirectoryPaths
              : new Set(coerceStringArray(psFolderState.expandedDirectoryPaths)),
            selectedFilePaths: shouldUseTopLevelSelections
              ? topLevelSelectedFilePaths
              : new Set(folderSelectionKeys),
            selectionModel:
              shouldUseTopLevelSelections && persistedSerialized.selectionModel
                ? topLevelSelectionModel
                : deserializeSelectionModel(psFolderState.selectionModel),
          },
        ];
      })
    ),
    isFilterChipsVisible: coerceBoolean(
      persistedSerialized.isFilterChipsVisible,
      current.isFilterChipsVisible
    ),
    isFiltersExpanded: coerceBoolean(
      persistedSerialized.isFiltersExpanded,
      current.isFiltersExpanded
    ),
    // Recovery is an in-memory hydration result, never persisted input. Pin it
    // to the live store so unknown/stale snapshot keys cannot fabricate a toast.
    persistenceRecoveryNotice: current.persistenceRecoveryNotice,
    quickFilter: coerceString(persistedSerialized.quickFilter, current.quickFilter),
    selectedFilePaths: topLevelSelectedFilePaths,
    selectionModel: topLevelSelectionModel,
    // Multi-root (Phase 4) fields — coerced safely from persisted data
    ...mergeActiveRoots(persistedSerialized, current),
  };

  for (const [key, folderState] of Object.entries(current.folderStates)) {
    if (!mergedState.folderStates[key]) {
      mergedState.folderStates[key] = folderState;
    }
  }

  // maxSelectionCount is WORKSPACE-GLOBAL. Profiles persisted in the
  // per-folder era can carry a degraded top-level value (the old default 10,
  // hydrated from whichever root was focused at save time) alongside a folder
  // snapshot holding the user's real setting. Heal by taking the most
  // generous persisted value and writing it through to every folder snapshot
  // so the copies can never diverge again (setMaxSelectionCount maintains the
  // same invariant going forward — this is idempotent on healthy profiles).
  // PERSISTED values only: mergedState.folderStates also contains the current
  // session's folder states, whose caps are seeded from the CURRENT default —
  // letting those into the max would silently override a user's deliberately
  // lower persisted setting whenever the shipped default rises.
  const mostGenerousPersistedCount = Object.values(persistedSerialized.folderStates ?? {}).reduce(
    (maxSoFar, folderState) => Math.max(maxSoFar, coerceNumber(folderState.maxSelectionCount, 0)),
    coerceNumber(persistedSerialized.maxSelectionCount, current.maxSelectionCount)
  );
  // Legacy-default heal: the pre-2026-07 default (10) was always persisted, so
  // a profile carrying exactly 10 everywhere is overwhelmingly a never-touched
  // default, not a choice — adopt the current default (a deliberate 10 can be
  // re-lowered once in settings). Every other value is a real user setting.
  const healedMaxSelectionCount =
    mostGenerousPersistedCount === LEGACY_DEFAULT_MAX_SELECTION_COUNT
      ? DEFAULT_MAX_SELECTION_COUNT
      : mostGenerousPersistedCount;
  mergedState.maxSelectionCount = healedMaxSelectionCount;
  for (const key of Object.keys(mergedState.folderStates)) {
    mergedState.folderStates[key] = {
      ...(mergedState.folderStates[key] as FolderState),
      maxSelectionCount: healedMaxSelectionCount,
    };
  }

  if (shouldLog) {
    // Log summary only to avoid DevTools serialization issues
    logger.debug(
      'Merge complete - Total folders:',
      Object.keys(mergedState.folderStates).length,
      'Has current folder:',
      mergedState.currentFolderId !== null
    );
  }
  return mergedState;
}
