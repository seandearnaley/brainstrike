/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */
import { useCallback } from 'react';
import { useFileExplorerStore } from '../stores/use-file-explorer-store';
export const useSelectionManager = ({ onSelectionLimitExceeded }) => {
    const { selectedFilePaths, maxSelectionCount, setSelectedFiles } = useFileExplorerStore();
    const wouldExceedSelectionLimit = useCallback((newFilePaths) => {
        const uniqueNewPaths = new Set(newFilePaths);
        const currentCount = selectedFilePaths.size;
        const additionalCount = Array.from(uniqueNewPaths).filter((path) => !selectedFilePaths.has(path)).length;
        return currentCount + additionalCount > maxSelectionCount;
    }, [selectedFilePaths, maxSelectionCount]);
    const handleSelectionChange = useCallback((selectedFiles) => {
        if (wouldExceedSelectionLimit(Array.from(selectedFiles))) {
            onSelectionLimitExceeded();
            return;
        }
        setSelectedFiles(selectedFiles);
    }, [wouldExceedSelectionLimit, onSelectionLimitExceeded, setSelectedFiles]);
    return {
        selectedFilePaths,
        handleSelectionChange,
        wouldExceedSelectionLimit,
    };
};
