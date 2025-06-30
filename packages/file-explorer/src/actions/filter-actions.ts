/**
 * Filter Actions
 *
 * This module contains actions for managing file filters in the file explorer.
 * These actions handle include/exclude patterns, regex mode, and project tree settings.
 */

import type { FileExplorerState } from '@brainstrike/types';
import {
  MIN_FOLDER_SUMMARY_THRESHOLD /*, MAX_FOLDER_SUMMARY_THRESHOLD */,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('filter-actions');

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
      logger.warn(
        `Folder summary threshold ${value} is below minimum ${MIN_FOLDER_SUMMARY_THRESHOLD}, using minimum value`
      );
      set(() => ({ folderSummaryThreshold: MIN_FOLDER_SUMMARY_THRESHOLD }));
      return;
    }
    set(() => ({ folderSummaryThreshold: value }));
  },
});
