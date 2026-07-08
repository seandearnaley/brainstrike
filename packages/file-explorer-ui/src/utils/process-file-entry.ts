import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { calculatePathDepth } from '@brainstrike/utils';
import { getFinalPath } from './get-final-path';

export function processFileEntry(
  entry: IFileNode,
  relativePath: string,
  directoryHandle: DirectoryHandle,
  rootFolderId: string
): IFileNode {
  const finalPath = getFinalPath(directoryHandle, entry, relativePath);

  return {
    ...entry,
    depth: calculatePathDepth(relativePath),
    path: finalPath,
    rootFolderId,
    selectionState: 'unchecked',
  };
}
