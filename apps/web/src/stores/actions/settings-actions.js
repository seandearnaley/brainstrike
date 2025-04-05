import { MAX_FOLDER_SUMMARY_THRESHOLD, MAX_SELECTION_COUNT, MIN_MAX_SELECTION_COUNT, } from '../constants/file-explorer-constants';
export const createSettingsActions = (set, _get // Re-added underscore to satisfy linter, despite usage in callback
) => ({
    setFilters: (include, exclude) => {
        set({ includeFilters: [...include], excludeFilters: [...exclude] });
    },
    setUseRegex: (useRegex) => {
        set({ useRegex });
    },
    setIncludeProjectTree: (value) => {
        set({ includeProjectTree: value });
    },
    setFolderSummaryThreshold: (value) => {
        const clampedValue = Math.max(0, Math.min(value, MAX_FOLDER_SUMMARY_THRESHOLD));
        set({ folderSummaryThreshold: clampedValue });
    },
    setMaxSelectionCount: (count) => {
        const clampedCount = Math.max(MIN_MAX_SELECTION_COUNT, Math.min(count, MAX_SELECTION_COUNT));
        set((state) => {
            let newSelectedFilePaths = state.selectedFilePaths;
            // If reducing the count, trim excess selected files
            if (clampedCount < state.selectedFilePaths.size) {
                newSelectedFilePaths = new Set(Array.from(state.selectedFilePaths).slice(0, clampedCount));
            }
            return { maxSelectionCount: clampedCount, selectedFilePaths: newSelectedFilePaths };
        });
    },
    setLastActiveTab: (tab) => {
        set({ lastActiveTab: tab });
    },
});
