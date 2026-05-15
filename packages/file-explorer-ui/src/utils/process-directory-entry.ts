import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { calculatePathDepth } from '@brainstrike/utils';
import { getFinalPath } from './get-final-path';

export type ReadTreeFn = (
  directoryHandle: DirectoryHandle,
  rootHandle: DirectoryHandle,
  parentPath?: string,
  isRoot?: boolean,
  abortSignal?: AbortSignal
) => Promise<IFileNode[]>;

export type SortFn = (nodes: IFileNode[]) => IFileNode[];

export async function processDirectoryEntry(
  entry: IFileNode,
  relativePath: string,
  directoryHandle: DirectoryHandle,
  rootHandle: DirectoryHandle,
  rootFolderId: string,
  readTree: ReadTreeFn,
  sortFileNodes: SortFn,
  abortSignal?: AbortSignal
): Promise<IFileNode> {
  const finalPath = getFinalPath(directoryHandle, entry, relativePath);

  const dirHandle: DirectoryHandle = {
    path: finalPath,
    name: entry.name,
    kind: 'directory',
    platform: directoryHandle.platform,
    _internal: entry.handle,
  };

  const children = await readTree(dirHandle, rootHandle, relativePath, false, abortSignal);

  return {
    ...entry,
    path: finalPath,
    depth: calculatePathDepth(relativePath),
    children: sortFileNodes(children),
    selectionState: 'unchecked',
    rootFolderId,
  };
}
