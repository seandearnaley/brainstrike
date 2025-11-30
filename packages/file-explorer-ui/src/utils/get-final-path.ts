import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { finalPath } from '@brainstrike/utils';

export const getFinalPath = (
  directoryHandle: DirectoryHandle,
  entry: IFileNode,
  relativePath: string
): string => finalPath(directoryHandle.platform, entry.path, relativePath);
