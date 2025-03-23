/**
 * File Explorer Constants
 *
 * This file contains constants used in the file explorer store.
 * These constants control various aspects of the store's behavior,
 * such as folder state management and default values.
 */

// Constants for folder state management
// We limit the number of folder states to prevent unbounded memory growth.
// This is particularly important because:
// 1. Each folder state contains Sets of file paths and expanded directories
// 2. Browser localStorage has limited space
// 3. We want to avoid memory leaks from accumulating too many states
export const MAX_FOLDER_STATES = 10;

// Minimum time difference (in ms) required between folder state updates
// This prevents excessive state updates when rapidly switching folders
export const MIN_TIME_BETWEEN_UPDATES = 100;

// Default values for store initialization
export const DEFAULT_FOLDER_STATE = {
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
  excludeFilters: [
    '.aider*',
    'node_modules',
    '.next',
    'coverage',
    'test-results',
    'playwright-report',
  ],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  maxSelectionCount: 100,
  lastActiveTab: undefined,
  lastAccessed: Date.now(),
};

// Minimum values for numeric settings to prevent invalid states
export const MIN_FOLDER_SUMMARY_THRESHOLD = 0;
export const MIN_MAX_SELECTION_COUNT = 1;
