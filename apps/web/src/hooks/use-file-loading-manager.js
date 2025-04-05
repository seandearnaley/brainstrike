/**
 * File Loading Manager Hook
 *
 * This hook manages the loading state of files in the file explorer.
 * It handles loading file content and tracking loading states.
 */
import { useCallback, useEffect, useState } from 'react';
export const useFileLoadingManager = ({ selectedFilePaths, fileContents, loadFileContent, }) => {
    const [loadingFiles, setLoadingFiles] = useState(new Set());
    const handleFileLoading = useCallback(async (path) => {
        setLoadingFiles((prev) => {
            const newSet = new Set(prev);
            newSet.add(path);
            return newSet;
        });
        try {
            await loadFileContent(path);
        }
        finally {
            setLoadingFiles((prev) => {
                const newSet = new Set(prev);
                newSet.delete(path);
                return newSet;
            });
        }
    }, [loadFileContent]);
    useEffect(() => {
        // Load content for all selected files
        for (const path of selectedFilePaths) {
            if (!fileContents[path]) {
                handleFileLoading(path);
            }
        }
    }, [selectedFilePaths, fileContents, handleFileLoading]);
    return {
        loadingFiles,
    };
};
