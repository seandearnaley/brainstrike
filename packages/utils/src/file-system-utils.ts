import type { IFileNode } from '@brainstrike/types';
import { IGNORED_PATHS } from '@brainstrike/types';
import { fileFilter } from './path-filter'; // Adjusted from '@brainstrike/utils'

// Moved from packages/file-explorer-ui/src/file-explorer-utils.ts
function normalizePath(pathString: string): string {
  // Remove duplicate slashes, handle leading slash
  return pathString.replace(/\/+/g, '/').replace(/^\/+/, '');
}

/**
 * Checks if a path should be ignored based on predefined patterns
 * Moved from packages/file-explorer-ui/src/file-explorer-utils.ts
 */
function shouldIgnorePath(pathString: string): boolean {
  const normalizedPath = normalizePath(pathString);
  return IGNORED_PATHS.some((ignoredPath) => fileFilter.matchWildcard(normalizedPath, ignoredPath));
}

/**
 * Reads the full file tree recursively from a directory handle
 * Moved from packages/file-explorer-ui/src/file-explorer-utils.ts
 * Made standalone and removed 'this' context.
 */
export async function readFullFileTree(
  directoryHandle: FileSystemDirectoryHandle,
  parentPath = '',
  depth = 0,
  rootFolderId = directoryHandle.name
): Promise<IFileNode[]> {
  const entries: IFileNode[] = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    const path = `${parentPath}/${name}`;
    // Use the local shouldIgnorePath function
    if (shouldIgnorePath(path)) continue;

    if (handle.kind === 'file') {
      entries.push({
        name,
        path,
        depth,
        type: 'file',
        handle: handle as FileSystemFileHandle,
        selectionState: 'unchecked', // Default value
        rootFolderId,
      });
    } else if (handle.kind === 'directory') {
      // Recursive call to the local readFullFileTree function
      const children = await readFullFileTree(
        handle as FileSystemDirectoryHandle,
        path,
        depth + 1,
        rootFolderId
      );
      entries.push({
        name,
        path,
        depth,
        type: 'directory',
        children,
        handle: handle as FileSystemDirectoryHandle,
        selectionState: 'unchecked', // Default value
        rootFolderId,
      });
    }
  }
  return entries;
}
