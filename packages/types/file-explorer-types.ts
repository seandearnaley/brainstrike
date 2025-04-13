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
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  lastAccessed: number;
}

export interface SerializedState {
  currentFolderId: string | null;
  folderStates: Record<string, SerializedFolderState>;
  selectedFilePaths: string[];
  expandedDirectoryPaths: string[];
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
}

export interface FolderState {
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
  lastAccessed: number;
}

// Data types
export interface FileExplorerData {
  currentFolderId: string | null;
  folderStates: Record<string, FolderState>;
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  maxSelectionCount: number;
  lastActiveTab: string;
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
  expandAllDirectories: (fileTree: import("./file-system").IFileNode[]) => void;
  collapseAllDirectories: () => void;
}

// Constants
export const MAX_FOLDER_STATES = 20;

export const DEFAULT_STATE = {
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: ["*.tsx", "*.ts", "*.js", "*.jsx", "*.json"] as string[],
  excludeFilters: [
    ".aider*",
    "node_modules",
    ".next",
    "coverage",
    "test-results",
    "playwright-report",
  ] as string[],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  maxSelectionCount: 100,
  lastActiveTab: 'files',
} as const;
