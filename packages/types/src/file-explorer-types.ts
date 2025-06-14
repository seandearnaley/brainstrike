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
  // Database-first properties
  databaseMode: boolean;
  isPopulated: boolean;
  populationProgress?:
    | {
        loaded: number;
        total: number;
        isLoading: boolean;
      }
    | undefined;
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
  // Database-first global properties
  databaseMode: boolean;
  currentFolderPopulated: boolean;
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
  // Database-first properties
  databaseMode: boolean;
  isPopulated: boolean;
  populationProgress?:
    | {
        loaded: number;
        total: number;
        isLoading: boolean;
      }
    | undefined;
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
  // Database-first global properties
  databaseMode: boolean;
  currentFolderPopulated: boolean;
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
  clearFileContents: (compositeKeys: string[]) => void;
  clearAllFileContents: () => void;

  // Database-first actions
  setDatabaseMode: (enabled: boolean) => void;
  setCurrentFolderPopulated: (populated: boolean) => void;
  setFolderPopulated: (folderId: string, populated: boolean) => void;
  setPopulationProgress: (
    folderId: string,
    progress: { loaded: number; total: number; isLoading: boolean }
  ) => void;
  clearPopulationProgress: (folderId: string) => void;
}

// Constants
export const MAX_FOLDER_STATES = 20;

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
  folderSummaryThreshold: 5,
  maxSelectionCount: 10,
  lastActiveTab: 'files',
  folderAccessOrder: [] as string[],
  fileContents: {} as Record<string, string>,
  // Database-first properties
  databaseMode: true, // Enable by default for new architecture
  currentFolderPopulated: false,
} as const;
