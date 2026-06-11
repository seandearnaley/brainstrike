/**
 * File Explorer Types
 *
 * This file contains type definitions for the file explorer store.
 * These types handle both runtime state and serialized state for persistence.
 */

// ============================================================================
// Selection Model Types
// ============================================================================

/**
 * Selection mode determines how files are selected.
 * - 'explicit': Traditional manual file selection (Set of composite keys)
 * - 'rules': Rule-based selection using SelectionRuleSet
 * - 'query': Query-backed recursive selection for large folder/root selections
 */
export type SelectionMode = 'explicit' | 'query' | 'rules';

export interface SelectionQueryDescriptor {
  coveredDirectoryPaths: string[];
  excludedPaths: string[];
  excludeFilters: string[];
  folderId: string;
  includedPaths: string[];
  includeFilters: string[];
  kind: 'recursive-folder' | 'recursive-select-all';
  manifestFingerprint: string | null;
  manifestSnapshotId: string | null;
  rootPath: string | null;
  totalSelectedCount: number;
  useRegex: boolean;
}

export interface QuerySelectionManifest {
  directoryCounts: Map<string, number>;
  errorMessage: string | null;
  filePaths: string[];
  fingerprint: string | null;
  pathSet: Set<string>;
  snapshotId: string | null;
  status: 'error' | 'loading' | 'ready';
}

/**
 * Selection model that supports explicit, rule-based, and query-backed selection.
 */
export interface SelectionModel {
  /**
   * Explicit selection paths (composite keys: folderId|@|path).
   * Used when mode is 'explicit' or as the committed result of rules.
   */
  explicitPaths: Set<string>;

  /**
   * Timestamp of last materialization (for cache invalidation).
   */
  materializedAt: string | null;

  /**
   * Cached materialized paths from rules (for display without re-evaluation).
   * These are relative paths, not composite keys.
   */
  materializedPaths: Set<string> | null;
  /** Current selection mode */
  mode: SelectionMode;

  /**
   * Query descriptor for large recursive selections.
   * Only used when mode is 'query'.
   */
  queryDescriptor: SelectionQueryDescriptor | null;

  /**
   * Rule set for rule-based selection.
   * Only used when mode is 'rules'.
   */
  ruleSetJson: string | null;
}

/**
 * Serialized version of SelectionModel for persistence.
 */
export interface SerializedSelectionModel {
  explicitPaths: string[];
  materializedAt: string | null;
  materializedPaths: string[] | null;
  mode: SelectionMode;
  queryDescriptor: SelectionQueryDescriptor | null;
  ruleSetJson: string | null;
}

/**
 * Create an empty selection model with explicit mode.
 */
export function createEmptySelectionModel(): SelectionModel {
  return {
    mode: 'explicit',
    explicitPaths: new Set(),
    ruleSetJson: null,
    materializedPaths: null,
    materializedAt: null,
    queryDescriptor: null,
  };
}

// ============================================================================
// Serialization Helper Types
// ============================================================================

// Helper types for serialization
export interface SerializedFolderState {
  excludeFilters: string[];
  expandedDirectoryPaths: string[];
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  lastAccessed: number;
  lastActiveTab: string;
  maxSelectionCount: number;
  selectedFilePaths: string[];
  selectionModel?: SerializedSelectionModel;
  tokenBudget: number;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   * Optional for backward compatibility with existing persisted state.
   */
  viewFilterPresetId?: string | null;
}

export interface SerializedState {
  currentFolderId: string | null;
  devInlineFixtureEnabled: boolean;
  excludeFilters: string[];
  expandedDirectoryPaths: string[];
  folderAccessOrder: string[];
  folderStates: Record<string, SerializedFolderState>;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  /**
   * Whether the filter chips row is visible inside the view filters section.
   * Optional for backward compatibility with existing persisted state.
   */
  isFilterChipsVisible?: boolean;
  /**
   * Whether the view filters section is expanded.
   * Optional for backward compatibility with existing persisted state.
   */
  isFiltersExpanded?: boolean;
  lastActiveTab: string;
  maxSelectionCount: number;
  quickFilter: string;
  selectedFilePaths: string[];
  /**
   * Selection model for rule-based selection.
   * Optional for backward compatibility with existing persisted state.
   */
  selectionModel?: SerializedSelectionModel;
  tokenBudget: number;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   * Optional for backward compatibility with existing persisted state.
   */
  viewFilterPresetId?: string | null;
}

export interface FolderState {
  excludeFilters: string[];
  expandedDirectoryPaths: Set<string>;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  lastAccessed: number;
  lastActiveTab: string;
  maxSelectionCount: number;
  selectedFilePaths: Set<string>;
  selectionModel: SelectionModel;
  tokenBudget: number;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   */
  viewFilterPresetId: string | null;
}

// Data types
export interface FileExplorerData {
  currentFolderId: string | null;
  /** Whether the inline dev fixture should be used instead of native FS access. */
  devInlineFixtureEnabled: boolean;
  /**
   * Set of exclude filter patterns that are temporarily disabled.
   * Disabled filters are not applied to the file tree but remain in the filter list.
   */
  disabledExcludeFilters: Set<string>;
  /**
   * Set of include filter patterns that are temporarily disabled.
   * Disabled filters are not applied to the file tree but remain in the filter list.
   */
  disabledIncludeFilters: Set<string>;
  excludeFilters: string[];
  expandedDirectoryPaths: Set<string>;
  fileContents: Record<string, string>;
  folderAccessOrder: string[];
  folderStates: Record<string, FolderState>;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  /**
   * Whether file system access is currently being loaded/restored.
   * Used to prevent stale state clearing during restore operations.
   * This is ephemeral state (not persisted).
   */
  isAccessLoading: boolean;
  /**
   * Whether the filter chips row is visible inside the view filters section.
   * Lets users reclaim vertical space without losing their active filters.
   * Persisted to remember user's preference across sessions.
   */
  isFilterChipsVisible: boolean;
  /**
   * Whether the view filters section (preset selector + filter chips) is expanded.
   * Persisted to remember user's preference across sessions.
   */
  isFiltersExpanded: boolean;
  lastActiveTab: string;
  maxSelectionCount: number;
  querySelectionManifest: QuerySelectionManifest | null;
  /**
   * Quick filter input in the sidebar filter bar.
   * Persisting this improves UX across unmounts and reloads.
   */
  quickFilter: string;
  selectedFilePaths: Set<string>;
  /**
   * Selection model supporting both explicit paths and rule-based selection.
   * Enables migration from explicit to rules while maintaining backward compatibility.
   */
  selectionModel: SelectionModel;
  /**
   * Version counter for selection changes.
   * Increments on every selection mutation, enabling efficient selectors
   * that only recompute when selection actually changes.
   * This is ephemeral state (not persisted).
   */
  selectionVersion: number;
  tokenBudget: number;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   */
  viewFilterPresetId: string | null;
}

export interface CacheStats {
  entryCount: number;
  evictionCount: number;
  hitRate: number;
  totalSize: number;
}

// Store interface extends data with actions
export interface FileExplorerState extends FileExplorerData {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  addMultipleSelectedFilesChunked: (
    folderId: string,
    paths: string[],
    options?: {
      chunkSize?: number;
      onProgress?: (processed: number, total: number) => void;
      signal?: AbortSignal;
    }
  ) => Promise<{ addedCount: number; cancelled: boolean; limitReached: boolean }>;
  addSelectedFile: (folderId: string, path: string) => void;
  clearAllFileContents: () => void;
  clearFileContents: (compositeKeys: string[]) => void;
  clearQuickFilter: () => void;
  clearSelectedFiles: () => void;
  clearSelectionRules: () => void;
  collapseAllDirectories: () => void;
  /**
   * Commit rule-based selection to explicit paths.
   * Converts materialized paths to explicit selection and switches to explicit mode.
   */
  commitRulesToExplicit: () => void;
  evictOldFileContents: (count?: number) => void;

  // New actions
  expandAllDirectories: (fileTree: import('./file-system').IFileNode[]) => void;
  getFileContent: (compositeKey: string) => string | undefined;
  getFileContentCacheStats: () => CacheStats;
  hydrateFolderState: (folderId: string) => void;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  removeSelectedFile: (folderId: string, path: string) => void;

  // Ephemeral handle for current root directory. Not serialized.
  rootDirectoryHandle: import('./file-system').DirectoryHandle | null;
  // Folder state management
  setCurrentFolderId: (folderId: string | null) => void;
  setDevInlineFixtureEnabled: (value: boolean) => void;

  // Directory expansion actions
  setExpandedPaths: (paths: ReadonlySet<string>) => void;

  // File content actions
  setFileContent: (compositeKey: string, content: string) => void;

  // Filter chips visibility state
  setFilterChipsVisible: (visible: boolean) => void;

  // Filter actions
  setFilters: (include: readonly string[], exclude: readonly string[]) => void;

  // View filters expansion state
  setFiltersExpanded: (expanded: boolean) => void;
  setFolderSummaryThreshold: (value: number) => void;
  setIncludeProjectTree: (value: boolean) => void;

  // Access loading state action (for blocking stale clearing during restore)
  setIsAccessLoading: (loading: boolean) => void;
  setLastActiveTab: (tab: string) => void;
  /**
   * Update materialized paths cache from rule evaluation.
   * Called after rules are evaluated against the file tree.
   */
  setMaterializedPaths: (paths: Set<string>) => void;
  setMaxSelectionCount: (count: number) => void;
  setQuerySelection: (
    descriptor: SelectionQueryDescriptor,
    manifest: QuerySelectionManifest,
    materializedPaths?: Set<string>
  ) => void;
  setQuerySelectionManifest: (manifest: QuerySelectionManifest | null) => void;

  // UI state actions (ephemeral + lightweight persisted)
  setQuickFilter: (value: string) => void;
  setRootDirectoryHandle: (handle: import('./file-system').DirectoryHandle | null) => void;

  // File selection actions
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;

  // Selection model actions (rule-based selection)
  setSelectionMode: (mode: SelectionMode) => void;
  setSelectionRules: (ruleSetJson: string) => void;
  setTokenBudget: (budget: number) => void;
  setUseRegex: (useRegex: boolean) => void;
  /**
   * Set the view filter preset ID for the current folder.
   * When set, filter values are derived from the preset.
   */
  setViewFilterPresetId: (presetId: string | null) => void;
  toggleDirectoryExpansion: (path: string) => void;
  /**
   * Toggle a filter's enabled/disabled state.
   * Disabled filters remain in the list but are not applied.
   */
  toggleFilterEnabled: (filter: string, type: 'include' | 'exclude') => void;
  toggleSelectedFile: (folderId: string, path: string) => void;
}

// Constants
export const MAX_FOLDER_STATES = 20;

/** Default number of files displayed before summarizing folders */
export const DEFAULT_FOLDER_SUMMARY_THRESHOLD = 5;

/** Default allowed number of file selections */
export const DEFAULT_MAX_SELECTION_COUNT = 10;

/** Default token budget for reports/token meter */
export const DEFAULT_TOKEN_BUDGET = 100_000;

export const DEFAULT_STATE = {
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'] as string[],
  excludeFilters: [
    '.aider*',
    'node_modules',
    '.next',
    'coverage',
    'test-results',
    'playwright-report',
  ] as string[],
  useRegex: false,
  includeProjectTree: true,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  // Used only when generating reports
  folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
  lastActiveTab: 'files',
  folderAccessOrder: [] as string[],
  fileContents: {} as Record<string, string>,
  quickFilter: '',
  querySelectionManifest: null as QuerySelectionManifest | null,
  devInlineFixtureEnabled: false,
  selectionModel: createEmptySelectionModel(),
  isAccessLoading: false,
  selectionVersion: 0,
  viewFilterPresetId: null as string | null,
  disabledIncludeFilters: new Set<string>(),
  disabledExcludeFilters: new Set<string>(),
  isFiltersExpanded: true,
  isFilterChipsVisible: true,
} as const;
