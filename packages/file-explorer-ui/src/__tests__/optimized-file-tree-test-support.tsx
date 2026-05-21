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
    name: 'src',
    path: '/src',
    type: 'directory',
    isVisible: true,
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    children: [
      {
        name: 'file1.txt',
        path: '/src/file1.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
      {
        name: 'file2.txt',
        path: '/src/file2.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
    ],
  },
  {
    name: 'test.txt',
    path: '/test.txt',
    type: 'file',
    isVisible: true,
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
  },
];
