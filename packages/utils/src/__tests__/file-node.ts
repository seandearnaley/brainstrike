import type { IFileNode } from '@brainstrike/types';

export function createFileNode({ name, path }: { name: string; path: string }): IFileNode {
  return {
    name,
    path,
    type: 'file',
    depth: path.split('/').length - 1,
    selectionState: 'unchecked',
    children: [],
    rootFolderId: 'test-folder',
    handle: {} as unknown as FileSystemFileHandle,
  };
}

export function createDirectoryNode({
  name,
  path,
  children = [],
}: { name: string; path: string; children?: IFileNode[] }): IFileNode {
  return {
    name,
    path,
    type: 'directory',
    depth: path.split('/').length - 1,
    selectionState: 'unchecked',
    children,
    rootFolderId: 'test-folder',
    handle: {} as unknown as FileSystemDirectoryHandle,
  };
}
