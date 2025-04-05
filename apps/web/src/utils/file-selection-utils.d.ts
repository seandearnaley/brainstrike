/**
 * Utilities for handling file selection composite keys.
 * These functions help manage file paths that are unique to specific root folders.
 */
/**
 * Creates a composite key from a folder ID and file path
 */
export declare function encodeFileSelection(folderId: string, filePath: string): string;
/**
 * Extracts the folder ID and file path from a composite key
 */
export declare function decodeFileSelection(compositeKey: string): {
    folderId: string;
    path: string;
};
/**
 * Checks if a path is selected within a specific folder
 */
export declare function isPathSelectedInFolder(selectedPaths: Set<string>, folderId: string, path: string): boolean;
/**
 * Gets all selected paths for a specific folder
 */
export declare function getSelectedPathsForFolder(selectedPaths: Set<string>, folderId: string): Set<string>;
//# sourceMappingURL=file-selection-utils.d.ts.map