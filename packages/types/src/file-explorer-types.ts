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
 */
export type SelectionMode = 'explicit' | 'rules';

/**
 * Selection model that supports both explicit and rule-based selection.
 * This abstraction allows coexistence during migration from explicit to rules.
 */
export interface SelectionModel {
  /** Current selection mode */
  mode: SelectionMode;

  /**
   * Explicit selection paths (composite keys: folderId|@|path).
   * Used when mode is 'explicit' or as the committed result of rules.
   */
  explicitPaths: Set<string>;

  /**
   * Rule set for rule-based selection.
   * Only used when mode is 'rules'.
   */
  ruleSetJson: string | null;

  /**
   * Cached materialized paths from rules (for display without re-evaluation).
   * These are relative paths, not composite keys.
   */
  materializedPaths: Set<string> | null;

  /**
   * Timestamp of last materialization (for cache invalidation).
   */
  materializedAt: string | null;
}

/**
 * Serialized version of SelectionModel for persistence.
 */
export interface SerializedSelectionModel {
  mode: SelectionMode;
  explicitPaths: string[];
  ruleSetJson: string | null;
  materializedPaths: string[] | null;
  materializedAt: string | null;
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
  };
}

// ============================================================================
// Serialization Helper Types
// ============================================================================

// Helper types for serialization
export interface SerializedFolderState {
  selectedFilePaths: string[];
  expandedDirectoryPaths: string[];
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  tokenBudget: number;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  lastAccessed: number;
}

export interface SerializedState {
  currentFolderId: string | null;
  folderStates: Record<string, SerializedFolderState>;
  folderAccessOrder: string[];
  selectedFilePaths: string[];
  expandedDirectoryPaths: string[];
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  tokenBudget: number;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  quickFilter: string;
  devInlineFixtureEnabled: boolean;
  /**
   * Selection model for rule-based selection.
   * Optional for backward compatibility with existing persisted state.
   */
  selectionModel?: SerializedSelectionModel;
}

export interface FolderState {
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  tokenBudget: number;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  lastAccessed: number;
}

// Data types
export interface FileExplorerData {
  currentFolderId: string | null;
  folderStates: Record<string, FolderState>;
  folderAccessOrder: string[];
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  tokenBudget: number;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  fileContents: Record<string, string>;
  /**
   * Quick filter input in the sidebar filter bar.
   * Persisting this improves UX across unmounts and reloads.
   */
  quickFilter: string;
  /** Whether the inline dev fixture should be used instead of native FS access. */
  devInlineFixtureEnabled: boolean;
  /**
   * Selection model supporting both explicit paths and rule-based selection.
   * Enables migration from explicit to rules while maintaining backward compatibility.
   */
  selectionModel: SelectionModel;
  /**
   * Whether file system access is currently being loaded/restored.
   * Used to prevent stale state clearing during restore operations.
   * This is ephemeral state (not persisted).
   */
  isAccessLoading: boolean;
}

export interface CacheStats {
  totalSize: number;
  entryCount: number;
  hitRate: number;
  evictionCount: number;
}

// Store interface extends data with actions
export interface FileExplorerState extends FileExplorerData {
  // Folder state management
  setCurrentFolderId: (folderId: string | null) => void;
  hydrateFolderState: (folderId: string) => void;

  // File selection actions
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
  addSelectedFile: (folderId: string, path: string) => void;
  removeSelectedFile: (folderId: string, path: string) => void;
  toggleSelectedFile: (folderId: string, path: string) => void;
  clearSelectedFiles: () => void;
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;

  // Directory expansion actions
  setExpandedPaths: (paths: ReadonlySet<string>) => void;
  toggleDirectoryExpansion: (path: string) => void;

  // Filter actions
  setFilters: (include: readonly string[], exclude: readonly string[]) => void;
  setUseRegex: (useRegex: boolean) => void;
  setIncludeProjectTree: (value: boolean) => void;
  setTokenBudget: (budget: number) => void;
  setFolderSummaryThreshold: (value: number) => void;
  setMaxSelectionCount: (count: number) => void;
  setLastActiveTab: (tab: string) => void;

  // New actions
  expandAllDirectories: (fileTree: import('./file-system').IFileNode[]) => void;
  collapseAllDirectories: () => void;

  // File content actions
  setFileContent: (compositeKey: string, content: string) => void;
  getFileContent: (compositeKey: string) => string | undefined;
  clearFileContents: (compositeKeys: string[]) => void;
  clearAllFileContents: () => void;
  getFileContentCacheStats: () => CacheStats;
  evictOldFileContents: (count?: number) => void;

  // UI state actions (ephemeral + lightweight persisted)
  setQuickFilter: (value: string) => void;
  clearQuickFilter: () => void;
  setDevInlineFixtureEnabled: (value: boolean) => void;

  // Selection model actions (rule-based selection)
  setSelectionMode: (mode: SelectionMode) => void;
  setSelectionRules: (ruleSetJson: string) => void;
  clearSelectionRules: () => void;
  /**
   * Commit rule-based selection to explicit paths.
   * Converts materialized paths to explicit selection and switches to explicit mode.
   */
  commitRulesToExplicit: () => void;
  /**
   * Update materialized paths cache from rule evaluation.
   * Called after rules are evaluated against the file tree.
   */
  setMaterializedPaths: (paths: Set<string>) => void;

  // Ephemeral handle for current root directory. Not serialized.
  rootDirectoryHandle: import('./file-system').DirectoryHandle | null;
  setRootDirectoryHandle: (handle: import('./file-system').DirectoryHandle | null) => void;

  // Access loading state action (for blocking stale clearing during restore)
  setIsAccessLoading: (loading: boolean) => void;
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
  devInlineFixtureEnabled: false,
  selectionModel: createEmptySelectionModel(),
  isAccessLoading: false,
} as const;
