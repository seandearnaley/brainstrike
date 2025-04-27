import { useCallback, useMemo } from 'react';

export const DEFAULT_INCLUDE_FILTERS = ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'];
const STORAGE_KEY = 'fileExplorerSettings';

export interface FileExplorerSettings {
  maxSelectionCount: number;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
}

const loadStoredSettings = (): FileExplorerSettings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Error loading file explorer settings:', error);
  }
  return {
    maxSelectionCount: 10,
    includeFilters: DEFAULT_INCLUDE_FILTERS,
    excludeFilters: ['node_modules', 'test-results', 'playwright-report'],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 100,
  };
};

export function useFileExplorerSettings() {
  // Use useMemo to maintain a stable settings object
  const settings = useMemo(() => loadStoredSettings(), []);

  const updateSettings = useCallback(
    (updates: Partial<FileExplorerSettings>) => {
      const newSettings = { ...settings, ...updates };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
        // Mutate settings object so all consumers see updates
        Object.assign(settings, updates);
      } catch (error) {
        console.error('Error saving file explorer settings:', error);
      }
    },
    [settings]
  );

  return { settings, updateSettings };
}
