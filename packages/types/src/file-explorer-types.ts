/**
 * File Explorer Types
 *
 * This file contains type definitions for the file explorer store.
 * These types handle both runtime state and serialized state for persistence.
 */

// Helper types for serialization
export interface SerializedFolderState {
  selectedFilePaths: string[];
  expandedDirectoryPaths: string[];
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
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
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  quickFilter: string;
  devInlineFixtureEnabled: boolean;
}

export interface FolderState {
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
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

  // Ephemeral handle for current root directory. Not serialized.
  rootDirectoryHandle: import('./file-system').DirectoryHandle | null;
  setRootDirectoryHandle: (handle: import('./file-system').DirectoryHandle | null) => void;
}

// Constants
export const MAX_FOLDER_STATES = 20;

/** Default number of files displayed before summarizing folders */
export const DEFAULT_FOLDER_SUMMARY_THRESHOLD = 5;

/** Default allowed number of file selections */
export const DEFAULT_MAX_SELECTION_COUNT = 10;

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
  // Used only when generating reports
  folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
  lastActiveTab: 'files',
  folderAccessOrder: [] as string[],
  fileContents: {} as Record<string, string>,
  quickFilter: '',
  devInlineFixtureEnabled: false,
} as const;
