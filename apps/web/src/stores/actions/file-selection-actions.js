import { encodeFileSelection } from '../../utils/file-selection-utils';
export const createFileSelectionActions = (set, _get // Marked as unused
) => ({
    setSelectedFiles: (selectedFiles) => {
        // Ensure all files in the set are properly encoded composite keys
        const validatedFiles = new Set();
        for (const file of selectedFiles) {
            // Only add files that are already in composite key format
            if (file.includes('|@|')) {
                validatedFiles.add(file);
            }
        }
        set({ selectedFilePaths: validatedFiles });
    },
    addSelectedFile: (folderId, path) => {
        set((state) => {
            const newSelectedFiles = new Set(state.selectedFilePaths);
            // Check against maxSelectionCount before adding
            if (newSelectedFiles.size < state.maxSelectionCount) {
                newSelectedFiles.add(encodeFileSelection(folderId, path));
            }
            return { selectedFilePaths: newSelectedFiles };
        });
    },
    removeSelectedFile: (folderId, path) => {
        set((state) => {
            const newSelectedFiles = new Set(state.selectedFilePaths);
            newSelectedFiles.delete(encodeFileSelection(folderId, path));
            return { selectedFilePaths: newSelectedFiles };
        });
    },
    toggleSelectedFile: (folderId, path) => {
        set((state) => {
            const newSelectedFiles = new Set(state.selectedFilePaths);
            const compositeKey = encodeFileSelection(folderId, path);
            if (newSelectedFiles.has(compositeKey)) {
                newSelectedFiles.delete(compositeKey);
            }
            else {
                // Check against maxSelectionCount before adding
                if (newSelectedFiles.size < state.maxSelectionCount) {
                    newSelectedFiles.add(compositeKey);
                }
            }
            return { selectedFilePaths: newSelectedFiles };
        });
    },
    clearSelectedFiles: () => {
        set({ selectedFilePaths: new Set() });
    },
});
