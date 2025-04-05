/**
 * Filter Actions
 *
 * This module contains actions for managing file filters in the file explorer.
 * These actions handle include/exclude patterns, regex mode, and project tree settings.
 */
import { MIN_FOLDER_SUMMARY_THRESHOLD } from '../constants/file-explorer-constants';
export const createFilterActions = (set) => ({
    setFilters: (include, exclude) => {
        set(() => ({
            includeFilters: [...include],
            excludeFilters: [...exclude],
        }));
    },
    setUseRegex: (useRegex) => {
        set(() => ({ useRegex }));
    },
    setIncludeProjectTree: (value) => {
        set(() => ({ includeProjectTree: value }));
    },
    setFolderSummaryThreshold: (value) => {
        if (value < MIN_FOLDER_SUMMARY_THRESHOLD) {
            console.warn('Folder summary threshold cannot be less than', MIN_FOLDER_SUMMARY_THRESHOLD);
            set(() => ({ folderSummaryThreshold: MIN_FOLDER_SUMMARY_THRESHOLD }));
            return;
        }
        set(() => ({ folderSummaryThreshold: value }));
    },
});
