export interface FileExplorerSettings {
  maxSelectionCount: number;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
}

export const DEFAULT_INCLUDE_FILTERS = ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'] as const;
export const DEFAULT_EXCLUDE_FILTERS = ['node_modules', 'test-results', 'playwright-report'] as const;
export const DEFAULT_USE_REGEX = false;
export const DEFAULT_INCLUDE_PROJECT_TREE = true;
export const DEFAULT_MAX_SELECTION_COUNT = 10;
export const DEFAULT_FOLDER_SUMMARY_THRESHOLD = 100;

export const MIN_MAX_SELECTION_COUNT = 1;
export const MAX_SELECTION_COUNT = 1000;
export const MIN_FOLDER_SUMMARY_THRESHOLD = 0;
export const MAX_FOLDER_SUMMARY_THRESHOLD = 1000; 