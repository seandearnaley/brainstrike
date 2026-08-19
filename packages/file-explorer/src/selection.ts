/**
 * File-explorer selection composite keys.
 * These functions keep file paths unique to their owning workspace root.
 */

const SEPARATOR = '|@|';

/**
 * Creates a composite key from a folder ID and file path
 */
export function encodeFileSelection(folderId: string, filePath: string): string {
  if (!(folderId && filePath)) {
    throw new Error('Both folderId and filePath are required for encoding');
  }
  return `${folderId}${SEPARATOR}${filePath}`;
}

/**
 * Extracts the folder ID and file path from a composite key
 */
export function decodeFileSelection(compositeKey: string): {
  folderId: string;
  path: string;
} {
  if (typeof compositeKey !== 'string') {
    throw new Error('Invalid composite key format');
  }
  const separatorIndex = compositeKey.indexOf(SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex + SEPARATOR.length >= compositeKey.length) {
    throw new Error('Invalid composite key format');
  }

  return {
    folderId: compositeKey.slice(0, separatorIndex),
    path: compositeKey.slice(separatorIndex + SEPARATOR.length),
  };
}

/**
 * Checks if a path is selected within a specific folder
 */
export function isPathSelectedInFolder(
  selectedPaths: Set<string>,
  folderId: string,
  path: string
): boolean {
  return selectedPaths.has(encodeFileSelection(folderId, path));
}

/**
 * Gets all selected paths for a specific folder
 */
export function getSelectedPathsForFolder(
  selectedPaths: ReadonlySet<string>,
  folderId: string
): Set<string> {
  const paths = new Set<string>();
  for (const compositeKey of selectedPaths) {
    const decoded = decodeFileSelection(compositeKey);
    if (decoded.folderId === folderId) {
      paths.add(decoded.path);
    }
  }
  return paths;
}

/**
 * Counts selected files under a directory by scanning the bounded selectedFilePaths set.
 * This is more efficient than building the full descendant list when selection count is small.
 *
 * @param selectedPaths - The set of selected file composite keys
 * @param folderId - The folder ID to scope the search
 * @param directoryPath - The directory path to count selected files under
 * @returns The count of selected files under the directory
 */
export function countSelectedInDirectory(
  selectedPaths: Set<string>,
  folderId: string,
  directoryPath: string
): number {
  // Build the prefix to match: "folderId|@|directoryPath/"
  // For root directory (empty path), match all files in the folder
  const prefix =
    directoryPath === '' ? `${folderId}${SEPARATOR}` : `${folderId}${SEPARATOR}${directoryPath}/`;

  let count = 0;
  for (const key of selectedPaths) {
    if (key.startsWith(prefix)) {
      count++;
    }
  }
  return count;
}
