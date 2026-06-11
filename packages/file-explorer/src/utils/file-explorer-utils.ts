import {
  createEmptySelectionModel,
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_TOKEN_BUDGET,
  type FileExplorerData,
  type FolderState,
  MAX_FOLDER_STATES,
} from '@brainstrike/types';

// Helper function to save current folder state.
// Phase 6 forest hardening: the snapshot PARTITIONS the live selection by key
// identity — only the outgoing folder's OWN composite keys belong in its
// snapshot. Foreign keys (cross-root writes that raced a focus switch into
// the top-level set) are routed to THEIR roots' folderStates instead of
// contaminating the outgoing snapshot, which made checkboxes flicker and
// selections "arrive late" in forest mode.
export const saveFolderState = (
  state: FileExplorerData,
  folderId: string,
  now = Date.now()
): Record<string, FolderState> => {
  const ownPrefix = `${folderId}|@|`;
  const ownKeys = new Set<string>();
  const foreignByFolder = new Map<string, Set<string>>();
  for (const key of state.selectedFilePaths) {
    const separatorIndex = key.indexOf('|@|');
    if (separatorIndex <= 0 || key.startsWith(ownPrefix)) {
      // Own keys and legacy separator-less keys stay with the snapshot.
      ownKeys.add(key);
      continue;
    }
    const keyFolderId = key.slice(0, separatorIndex);
    const bucket = foreignByFolder.get(keyFolderId) ?? new Set<string>();
    bucket.add(key);
    foreignByFolder.set(keyFolderId, bucket);
  }
  const baseModel = state.selectionModel ?? createEmptySelectionModel();
  const snapshotModel =
    baseModel.mode === 'explicit' && foreignByFolder.size > 0
      ? { ...baseModel, explicitPaths: new Set(ownKeys) }
      : baseModel;

  const folderState: FolderState = {
    selectedFilePaths: ownKeys,
    selectionModel: snapshotModel,
    expandedDirectoryPaths: state.expandedDirectoryPaths,
    includeFilters: state.includeFilters,
    excludeFilters: state.excludeFilters,
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    tokenBudget: state.tokenBudget,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastAccessed: now,
    lastActiveTab: state.lastActiveTab || 'files',
    viewFilterPresetId: state.viewFilterPresetId,
  };

  let folderStates: Record<string, FolderState> = {
    ...state.folderStates,
    [folderId]: folderState,
  };
  for (const [foreignFolderId, keys] of foreignByFolder) {
    const base = folderStates[foreignFolderId] ?? createNewFolderState(state, now);
    const merged = new Set(base.selectedFilePaths);
    for (const key of keys) {
      merged.add(key);
    }
    folderStates = {
      ...folderStates,
      [foreignFolderId]: {
        ...base,
        lastAccessed: now,
        selectedFilePaths: merged,
        selectionModel: {
          ...base.selectionModel,
          mode: 'explicit',
          explicitPaths: new Set(merged),
        },
      },
    };
  }
  return folderStates;
};

// Helper function to clean up old folder states

export const updateFolderAccessOrder = (order: readonly string[], folderId: string): string[] => {
  const newOrder = order.filter((id) => id !== folderId);
  newOrder.push(folderId);
  return newOrder;
};

export const cleanupOldFolderStates = (
  folderStates: Record<string, FolderState>,
  order: readonly string[]
): { folderStates: Record<string, FolderState>; order: string[] } => {
  const newStates = { ...folderStates };
  // Remove any ids from the order array that no longer exist in folderStates
  let newOrder = order.filter((id) => newStates[id]);

  while (newOrder.length > MAX_FOLDER_STATES) {
    const oldestId = newOrder.shift();
    if (oldestId) {
      delete newStates[oldestId];
    }
  }

  // After potentially deleting states due to the max limit, ensure order only
  // contains ids that still exist
  newOrder = newOrder.filter((id) => newStates[id]);

  return { folderStates: newStates, order: newOrder };
};

// Helper function to create a new folder state
export const createNewFolderState = (
  stateOrNow?:
    | Pick<
        FileExplorerData,
        | 'excludeFilters'
        | 'folderSummaryThreshold'
        | 'includeFilters'
        | 'includeProjectTree'
        | 'lastActiveTab'
        | 'maxSelectionCount'
        | 'tokenBudget'
        | 'useRegex'
        | 'viewFilterPresetId'
      >
    | number,
  maybeNow = Date.now()
): FolderState => {
  const state = typeof stateOrNow === 'number' || stateOrNow === undefined ? undefined : stateOrNow;
  const now = typeof stateOrNow === 'number' ? stateOrNow : maybeNow;

  return {
    selectedFilePaths: new Set<string>(),
    selectionModel: createEmptySelectionModel(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: state ? [...state.includeFilters] : [],
    excludeFilters: state ? [...state.excludeFilters] : [],
    useRegex: state?.useRegex ?? false,
    includeProjectTree: state?.includeProjectTree ?? true,
    tokenBudget: state?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    folderSummaryThreshold: state?.folderSummaryThreshold ?? DEFAULT_FOLDER_SUMMARY_THRESHOLD,
    maxSelectionCount: state?.maxSelectionCount ?? DEFAULT_MAX_SELECTION_COUNT,
    lastActiveTab: state?.lastActiveTab ?? 'files',
    lastAccessed: now,
    viewFilterPresetId: state?.viewFilterPresetId ?? null,
  };
};
