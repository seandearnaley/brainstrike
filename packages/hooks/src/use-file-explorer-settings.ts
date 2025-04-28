import {
  DEFAULT_EXCLUDE_FILTERS,
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_INCLUDE_FILTERS,
  DEFAULT_INCLUDE_PROJECT_TREE,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_USE_REGEX,
} from '@brainstrike/types';
import { useCallback, useMemo } from 'react';

export interface FileExplorerSettings {
  maxSelectionCount: number;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
}

const loadStoredSettings = (): FileExplorerSettings => {
  if (typeof window === 'undefined') {
    return {
      maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
      includeFilters: [...DEFAULT_INCLUDE_FILTERS],
      excludeFilters: [...DEFAULT_EXCLUDE_FILTERS],
      useRegex: DEFAULT_USE_REGEX,
      includeProjectTree: DEFAULT_INCLUDE_PROJECT_TREE,
      folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
    };
  }
  try {
    const stored = localStorage.getItem('fileExplorerSettings');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Error loading file explorer settings:', error);
  }
  return {
    maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
    includeFilters: [...DEFAULT_INCLUDE_FILTERS],
    excludeFilters: [...DEFAULT_EXCLUDE_FILTERS],
    useRegex: DEFAULT_USE_REGEX,
    includeProjectTree: DEFAULT_INCLUDE_PROJECT_TREE,
    folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  };
};

export function useFileExplorerSettings() {
  // Use useMemo to maintain a stable settings object
  const settings = useMemo(() => loadStoredSettings(), []);

  const updateSettings = useCallback(
    (updates: Partial<FileExplorerSettings>) => {
      if (typeof window === 'undefined') return;
      const newSettings = { ...settings, ...updates };
      try {
        localStorage.setItem('fileExplorerSettings', JSON.stringify(newSettings));
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
