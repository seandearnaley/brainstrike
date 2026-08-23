import type { IFileNode } from '@brainstrike/types';

export interface RecursiveSelectionBufferProfile {
  /** Directory entries retained across traversal-owned frontier arrays. */
  bufferedDirectoryEntries: number;
}

export function compactDirectoryIntoFrontier(args: {
  directoryEntries: number;
  frontier: IFileNode[];
  node: IFileNode;
  targetIndex: number;
}): number {
  const { directoryEntries, frontier, node, targetIndex } = args;
  const nextDirectoryEntries =
    frontier[targetIndex]?.type === 'directory' ? directoryEntries : directoryEntries + 1;
  frontier[targetIndex] = node;
  return nextDirectoryEntries;
}
