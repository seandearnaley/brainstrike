import type { IFileNode } from '@brainstrike/types';
import { useEffect } from 'react';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';

export type FileExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;

export function StoreHandleBridge({
  onStoreReady,
}: {
  onStoreReady: (store: FileExplorerStore) => void;
}) {
  const store = useFileExplorerStoreContext();
  useEffect(() => {
    onStoreReady(store);
  }, [onStoreReady, store]);
  return null;
}

export const mockFileTree: IFileNode[] = [
  {
    children: [
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: 'file1.txt',
        path: '/src/file1.txt',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: 'file2.txt',
        path: '/src/file2.txt',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
    ],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    name: 'src',
    path: '/src',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  },
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'test.txt',
    path: '/test.txt',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  },
];
