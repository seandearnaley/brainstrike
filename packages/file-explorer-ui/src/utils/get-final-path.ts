import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';

export const getFinalPath = (
  directoryHandle: DirectoryHandle,
  entry: IFileNode,
  relativePath: string
): string => {
  return directoryHandle.platform === 'electron' ? entry.path : relativePath;
};
