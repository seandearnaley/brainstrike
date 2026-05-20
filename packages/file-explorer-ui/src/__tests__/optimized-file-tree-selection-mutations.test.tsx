import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, memoizedFileExplorer } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import OptimizedFileTree from '../tree/optimized-file-tree';
import {
  type FileExplorerStore,
  mockFileTree,
  StoreHandleBridge,
} from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

describe('OptimizedFileTree selection mutations and telemetry', () => {
  it('does not recompute directory file counts on file-selection rerenders', async () => {
    const getFolderFileCountSpy = vi.spyOn(memoizedFileExplorer, 'getFolderFileCount');
    try {
      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const initialCallCount = getFolderFileCountSpy.mock.calls.length;
      const fileCheckbox = screen.getByLabelText('Select test.txt');

      await act(async () => {
        fireEvent.click(fileCheckbox);
      });
      await act(async () => {
        fireEvent.click(fileCheckbox);
      });

      expect(getFolderFileCountSpy.mock.calls.length).toBe(initialCallCount);
    } finally {
      getFolderFileCountSpy.mockRestore();
    }
  });

  it('keeps directory selection counts stable across StrictMode rerenders', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
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
    ];
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <StrictMode>
        <FileExplorerTestWrapper>
          <StoreHandleBridge
            onStoreReady={(store) => {
              fileExplorerStore = store;
            }}
          />
          <OptimizedFileTree fileTree={loadedTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      </StrictMode>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(10);
      await Promise.resolve();
    });

    const directoryCheckbox = screen.getByLabelText('Select src');
    expect(directoryCheckbox).toHaveAttribute('data-state', 'unchecked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(directoryCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('selects all unselected files in a directory when capacity allows', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().setMaxSelectionCount(2);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    const selectedKeys = Array.from(readyStore.getState().selectedFilePaths);
    const selectedSourceFiles = selectedKeys.filter((key) => key.startsWith('root|@|/src/'));

    expect(selectedKeys).toHaveLength(2);
    expect(selectedSourceFiles).toHaveLength(2);
  });

  it('removes all files in a fully selected directory on second toggle', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(4);
      await Promise.resolve();
    });

    const getSelectedSourceFiles = (): string[] =>
      Array.from(readyStore.getState().selectedFilePaths).filter((key) =>
        key.startsWith('root|@|/src/')
      );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    expect(getSelectedSourceFiles()).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    expect(getSelectedSourceFiles()).toHaveLength(0);
  });

  it('does not change selection when toggling an empty directory', async () => {
    const treeWithEmptyDirectory: IFileNode[] = [
      {
        name: 'empty',
        path: '/empty',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [],
      },
    ];
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={treeWithEmptyDirectory}
          folderId="root"
          loadingFiles={new Set()}
        />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    expect(readyStore.getState().selectedFilePaths.size).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select empty'));
    });
    expect(readyStore.getState().selectedFilePaths.size).toBe(0);
  });

  it('uses recursive directory selection callback for unloaded folders', async () => {
    const onSelectFolderRecursively = vi.fn(async () => ({ success: true, filePaths: [] }));

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={mockFileTree}
            folderId="root"
            loadingFiles={new Set()}
            onSelectFolderRecursively={onSelectFolderRecursively}
          />
        </FileExplorerTestWrapper>
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    expect(onSelectFolderRecursively).toHaveBeenCalledTimes(1);
    expect(onSelectFolderRecursively).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/src', type: 'directory' })
    );
  });

  it('removes already-selected query descendants instead of re-running recursive selection for an unloaded folder', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const onSelectFolderRecursively = vi.fn(async () => ({ success: true, filePaths: [] }));

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={mockFileTree}
          folderId="root"
          loadingFiles={new Set()}
          onSelectFolderRecursively={onSelectFolderRecursively}
        />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().setQuerySelection(
        {
          kind: 'recursive-select-all',
          folderId: 'root',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-src-query',
          manifestSnapshotId: 'snapshot-src-query',
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          filePaths: ['/src/file1.txt', '/src/file2.txt'],
          pathSet: new Set(['/src/file1.txt', '/src/file2.txt']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-src-query',
          snapshotId: 'snapshot-src-query',
          status: 'ready',
          errorMessage: null,
        },
        new Set(['/src/file1.txt', '/src/file2.txt'])
      );
      await Promise.resolve();
    });

    const srcCheckbox = screen.getByLabelText('Select src');
    expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      fireEvent.click(srcCheckbox);
      await Promise.resolve();
    });

    expect(onSelectFolderRecursively).not.toHaveBeenCalled();
    expect(readyStore.getState().selectionModel.mode).toBe('query');
    expect(readyStore.getState().selectionModel.queryDescriptor?.excludedPaths).toEqual([
      '/src/file1.txt',
      '/src/file2.txt',
    ]);
  });

  it('clears selected descendants for a partially restored explicit directory instead of continuing recursive selection', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const onSelectFolderRecursively = vi.fn(async () => ({ success: true, filePaths: [] }));

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={mockFileTree}
          folderId="root"
          loadingFiles={new Set()}
          onSelectFolderRecursively={onSelectFolderRecursively}
        />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().setSelectedFiles(new Set(['root|@|/src/file1.txt']));
      await Promise.resolve();
    });

    const srcCheckbox = screen.getByLabelText('Select src');
    expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      fireEvent.click(srcCheckbox);
      await Promise.resolve();
    });

    expect(onSelectFolderRecursively).not.toHaveBeenCalled();
    expect(readyStore.getState().selectedFilePaths).toEqual(new Set());
    expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('blocks new file selection when max selection capacity is reached', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(1);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select test.txt'));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    const selectedKeys = Array.from(readyStore.getState().selectedFilePaths);
    expect(selectedKeys).toEqual([encodeFileSelection('root', '/test.txt')]);
  });
});
