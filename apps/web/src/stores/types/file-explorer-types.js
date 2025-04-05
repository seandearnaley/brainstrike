/**
 * File Explorer Types
 *
 * This file contains type definitions for the file explorer store.
 * These types handle both runtime state and serialized state for persistence.
 */
// Constants
export const MAX_FOLDER_STATES = 20;
export const DEFAULT_STATE = {
    selectedFilePaths: new Set(),
    expandedDirectoryPaths: new Set(),
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
};
