import type { IFileNode } from '@brainstrike/types';
import { IGNORED_PATHS } from '@brainstrike/types';

// Create a Set for O(1) lookups
const IGNORED_PATH_SET = new Set(IGNORED_PATHS);

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
    // Optimization: Check ignore list BEFORE path construction
    if (IGNORED_PATH_SET.has(name)) {
      continue;
    }

    const currentPath = `${parentPath}/${name}`;

    if (handle.kind === 'file') {
      entries.push({
        depth,
        handle: handle as FileSystemFileHandle,
        isDepthTruncated: false,
        isSymbolicLink: false,
        name,
        path: currentPath,
        rootFolderId,
        selectionState: 'unchecked', // Default value
        type: 'file',
      });
    } else if (handle.kind === 'directory') {
      // 1. Check depth limit first
      if (depth >= maxDepth - 1) {
        entries.push({
          children: [], // No further recursion
          depth,
          handle: handle as FileSystemDirectoryHandle,
          isDepthTruncated: true, // Mark as depth truncated
          isSymbolicLink: false,
          name,
          path: currentPath,
          rootFolderId,
          selectionState: 'unchecked',
          type: 'directory',
        });
        continue; // Stop processing this directory further
      }

      // 2. Check for circular references (symbolic links)
      if (visitedHandles.has(handle as FileSystemDirectoryHandle)) {
        entries.push({
          children: [], // No further recursion
          depth,
          handle: handle as FileSystemDirectoryHandle,
          isDepthTruncated: false,
          isSymbolicLink: true, // Mark as symlink/cycle
          name,
          path: currentPath,
          rootFolderId,
          selectionState: 'unchecked',
          type: 'directory',
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
        children,
        depth,
        handle: handle as FileSystemDirectoryHandle,
        isDepthTruncated: false,
        isSymbolicLink: false,
        name,
        path: currentPath,
        rootFolderId,
        selectionState: 'unchecked', // Default value
        type: 'directory',
      });
    }
  }
  return entries;
}
