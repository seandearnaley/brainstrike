import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
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
    path: finalPath,
    depth: relativePath.split('/').length - 1,
    selectionState: 'unchecked',
    rootFolderId,
  };
}
