/**
 * Utilities for handling file selection composite keys.
 * These functions help manage file paths that are unique to specific root folders.
 */
const SEPARATOR = '|@|';
/**
 * Creates a composite key from a folder ID and file path
 */
export function encodeFileSelection(folderId, filePath) {
    if (!folderId || !filePath) {
        throw new Error('Both folderId and filePath are required for encoding');
    }
    return `${folderId}${SEPARATOR}${filePath}`;
}
/**
 * Extracts the folder ID and file path from a composite key
 */
export function decodeFileSelection(compositeKey) {
    if (!compositeKey || !compositeKey.includes(SEPARATOR)) {
        throw new Error('Invalid composite key format');
    }
    const [folderId, ...pathParts] = compositeKey.split(SEPARATOR);
    return { folderId, path: pathParts.join(SEPARATOR) };
}
/**
 * Checks if a path is selected within a specific folder
 */
export function isPathSelectedInFolder(selectedPaths, folderId, path) {
    return selectedPaths.has(encodeFileSelection(folderId, path));
}
/**
 * Gets all selected paths for a specific folder
 */
export function getSelectedPathsForFolder(selectedPaths, folderId) {
    const paths = new Set();
    for (const compositeKey of selectedPaths) {
        try {
            const decoded = decodeFileSelection(compositeKey);
            if (decoded.folderId === folderId) {
                paths.add(decoded.path);
            }
        }
        catch {
            // Skip invalid composite keys
        }
    }
    return paths;
}
