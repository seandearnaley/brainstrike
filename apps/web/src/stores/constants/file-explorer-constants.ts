/**
 * Constants related to the File Explorer feature.
 */

// Maximum number of folder states to keep in memory (LRU cache)
export const MAX_FOLDER_STATES = 20;

// Default include/exclude filters (example, adjust as needed)
export const DEFAULT_INCLUDE_FILTERS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.json', '*.md'];
export const DEFAULT_EXCLUDE_FILTERS = [
  'node_modules',
  '.git',
  '.vscode',
  'dist',
  'build',
  'coverage',
  '*.log',
  '*.lock',
];

// Minimum and Maximum allowed value for Folder Summary Threshold setting
export const MIN_FOLDER_SUMMARY_THRESHOLD = 0;
export const MAX_FOLDER_SUMMARY_THRESHOLD = 1000; // Added Max Value

// Minimum and Maximum allowed value for Max Selection Count setting
export const MIN_MAX_SELECTION_COUNT = 1;
export const MAX_SELECTION_COUNT = 1000; // Added Max Value

// Default state values used in the store
export const DEFAULT_FOLDER_SUMMARY_THRESHOLD = 100;
export const DEFAULT_MAX_SELECTION_COUNT = 100;
export const DEFAULT_USE_REGEX = false;
export const DEFAULT_INCLUDE_PROJECT_TREE = true;
export const DEFAULT_LAST_ACTIVE_TAB = 'files';

// Separator used for encoding folderId and path in selectedFilePaths Set
export const FILE_SELECTION_SEPARATOR = '|@|';
