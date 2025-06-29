import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { fileFilter } from '@brainstrike/utils';
import { processDirectoryEntry, type ReadTreeFn, type SortFn } from './process-directory-entry';
import { processFileEntry } from './process-file-entry';

export async function readFullTree(
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  rootHandle: DirectoryHandle,
  parentPath = '',
  _isRoot = true,
  abortSignal?: AbortSignal,
  updateProgress?: (path?: string) => void,
  sortFileNodes: SortFn = (nodes) => nodes
): Promise<IFileNode[]> {
  const rootFolderId = rootHandle.name;

  const boundRead: ReadTreeFn = (dirHandle, root, parent, rootFlag, signal) =>
    readFullTree(
      fileSystemAdapter,
      dirHandle,
      root,
      parent,
      rootFlag,
      signal,
      updateProgress,
      sortFileNodes
    );

  function checkAbortSignal(): void {
    if (abortSignal?.aborted) {
      throw new DOMException('Operation was cancelled', 'AbortError');
    }
  }

  function buildRelativePath(parent: string, entryName: string): string {
    return parent ? `${parent}/${entryName}` : entryName;
  }

  async function* processEntry(
    entry: IFileNode,
    relativePath: string,
    dir: DirectoryHandle
  ): AsyncGenerator<IFileNode> {
    checkAbortSignal();
    updateProgress?.(relativePath);

    if (entry.type === 'file') {
      yield processFileEntry(entry, relativePath, dir, rootFolderId);
    } else if (entry.type === 'directory') {
      const dirNode = await processDirectoryEntry(
        entry,
        relativePath,
        dir,
        rootHandle,
        rootFolderId,
        boundRead,
        sortFileNodes,
        abortSignal
      );
      yield dirNode;
    }
  }

  async function* walk(dir: DirectoryHandle, parent: string): AsyncGenerator<IFileNode> {
    checkAbortSignal();
    const entries = await fileSystemAdapter.readDirectory(dir);

    for (const entry of entries) {
      const relativePath = buildRelativePath(parent, entry.name);

      if (fileFilter.shouldIgnorePath(relativePath)) {
        continue;
      }

      yield* processEntry(entry, relativePath, dir);
    }
  }

  const nodes: IFileNode[] = [];
  for await (const node of walk(directoryHandle, parentPath)) {
    nodes.push(node);
  }

  return sortFileNodes(nodes);
}
