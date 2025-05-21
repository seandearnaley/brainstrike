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
  rootFolderId = directoryHandle.name,
  visitedHandles: Set<FileSystemDirectoryHandle> = new Set(),
  maxDepth = 30 // Added maxDepth parameter
): Promise<IFileNode[]> {
  const entries: IFileNode[] = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    const currentPath = `${parentPath}/${name}`;
    // Use the local shouldIgnorePath function
    if (shouldIgnorePath(currentPath)) continue;

    if (handle.kind === 'file') {
      entries.push({
        name,
        path: currentPath,
        depth,
        type: 'file',
        handle: handle as FileSystemFileHandle,
        selectionState: 'unchecked', // Default value
        rootFolderId,
        isSymbolicLink: false,
        isDepthTruncated: false,
      });
    } else if (handle.kind === 'directory') {
      // 1. Check depth limit first
      if (depth >= maxDepth - 1) {
        entries.push({
          name,
          path: currentPath,
          depth,
          type: 'directory',
          children: [], // No further recursion
          handle: handle as FileSystemDirectoryHandle,
          selectionState: 'unchecked',
          rootFolderId,
          isSymbolicLink: false,
          isDepthTruncated: true, // Mark as depth truncated
        });
        continue; // Stop processing this directory further
      }

      // 2. Check for circular references (symbolic links)
      if (visitedHandles.has(handle as FileSystemDirectoryHandle)) {
        entries.push({
          name,
          path: currentPath,
          depth,
          type: 'directory',
          children: [], // No further recursion
          handle: handle as FileSystemDirectoryHandle,
          selectionState: 'unchecked',
          rootFolderId,
          isSymbolicLink: true, // Mark as symlink/cycle
          isDepthTruncated: false,
        });
        continue; // Stop processing this directory further
      }

      // 3. If not too deep and not a cycle, proceed with recursion
      // Create a new Set for the recursive call, including the current path
      const newVisitedHandles = new Set(visitedHandles);
      newVisitedHandles.add(handle as FileSystemDirectoryHandle);

      const children = await readFullFileTree(
        handle as FileSystemDirectoryHandle,
        currentPath, // Use unnormalized currentPath for parentPath in recursion
        depth + 1,
        rootFolderId,
        newVisitedHandles, // Pass the new set for cycle detection
        maxDepth // Pass maxDepth along
      );
      entries.push({
        name,
        path: currentPath,
        depth,
        type: 'directory',
        children,
        handle: handle as FileSystemDirectoryHandle,
        selectionState: 'unchecked', // Default value
        rootFolderId,
        isSymbolicLink: false,
        isDepthTruncated: false,
      });
    }
  }
  return entries;
}
