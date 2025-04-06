/**
 * Filter Actions
 *
 * This module contains actions for managing file filters in the file explorer.
 * These actions handle include/exclude patterns, regex mode, and project tree settings.
 */

import type { FileExplorerState } from '@brainstrike/types';
import { MIN_FOLDER_SUMMARY_THRESHOLD } from '../constants/file-explorer-constants';

export const createFilterActions = (
  set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void
) => ({
  setFilters: (include: readonly string[], exclude: readonly string[]) => {
    set(() => ({
      includeFilters: [...include],
      excludeFilters: [...exclude],
    }));
  },

  setUseRegex: (useRegex: boolean) => {
    set(() => ({ useRegex }));
  },

  setIncludeProjectTree: (value: boolean) => {
    set(() => ({ includeProjectTree: value }));
  },

  setFolderSummaryThreshold: (value: number) => {
    if (value < MIN_FOLDER_SUMMARY_THRESHOLD) {
      console.warn('Folder summary threshold cannot be less than', MIN_FOLDER_SUMMARY_THRESHOLD);
      set(() => ({ folderSummaryThreshold: MIN_FOLDER_SUMMARY_THRESHOLD }));
      return;
    }
    set(() => ({ folderSummaryThreshold: value }));
  },
});
