import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, memoizedFileExplorer } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OptimizedFileTree from '../tree/optimized-file-tree';

const showToastMock = vi.fn();

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useToastManager: () => ({
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleRefreshError: vi.fn(),
      showToast: showToastMock,
      toast: vi.fn(),
    }),
  };
});

import {
  type FileExplorerStore,
  mockFileTree,
  StoreHandleBridge,
} from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

describe('OptimizedFileTree selection mutations and telemetry', () => {
  beforeEach(() => {
    showToastMock.mockClear();
  });

  it('partial-fills a folder selection up to the limit and toasts, instead of disabling the checkbox', async () => {
    // Decision D3 (docs/explorer-tristate-spike-2026-07-11.md §5): a folder
    // whose full selection would exceed the cap stays clickable, fills the
    // remaining slots, and reports the truncation — the cap must never
    // present a dead/disabled folder checkbox.
    const loadedTree: IFileNode[] = [
      {
        children: ['file1.txt', 'file2.txt', 'file3.txt', 'file4.txt'].map((name) => ({
          depth: 1,
          handle: {} as FileSystemFileHandle,
          isVisible: true,
          name,
          path: `/src/${name}`,
          rootFolderId: 'root',
          selectionState: 'unchecked' as const,
          type: 'file' as const,
        })),
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'src',
        path: '/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
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
        <OptimizedFileTree fileTree={loadedTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().setMaxSelectionCount(2);
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });

    const directoryCheckbox = screen.getByLabelText('Select src');
    expect(directoryCheckbox).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(directoryCheckbox);
    });

    expect(Array.from(readyStore.getState().selectedFilePaths)).toHaveLength(2);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Selection limit reached (2)' })
    );
  });

  it('disables file checkboxes while a recursive selection is loading', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;

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
          isLoadingForSelection={true}
          loadingFiles={new Set()}
          loadingPathForSelection="/src"
        />
      </FileExplorerTestWrapper>
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Neutralize any cap carry-over from sibling tests (the wrapper store is
    // shared) so the assertion isolates the scan lock, not wouldExceedLimit.
    await act(async () => {
      fileExplorerStore?.getState().clearSelectedFiles();
      fileExplorerStore?.getState().setMaxSelectionCount(100);
      await Promise.resolve();
    });

    // Clicks are ignored while the scan runs (handleNodeSelection early-
    // returns), so the affordance must not lie: file checkboxes disable too,
    // not only directories.
    expect(screen.getByLabelText('Select test.txt')).toBeDisabled();
  });

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
        loadState: 'loaded',
        name: 'src',
        path: '/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
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

  it('selects the remaining files when clicking a partially selected loaded directory', async () => {
    // Decision D1 (docs/explorer-tristate-spike-2026-07-11.md §5): clicking a
    // mixed/indeterminate folder COMPLETES the selection (native-checkbox and
    // file-picker idiom), it does not clear it.
    const loadedTree: IFileNode[] = [
      {
        children: ['file1.txt', 'file2.txt', 'file3.txt'].map((name) => ({
          depth: 1,
          handle: {} as FileSystemFileHandle,
          isVisible: true,
          name,
          path: `/src/${name}`,
          rootFolderId: 'root',
          selectionState: 'unchecked' as const,
          type: 'file' as const,
        })),
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'src',
        path: '/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
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
        <OptimizedFileTree fileTree={loadedTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().setMaxSelectionCount(10);
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });

    const directoryCheckbox = screen.getByLabelText('Select src');
    expect(directoryCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      fireEvent.click(directoryCheckbox);
    });

    const selectedKeys = Array.from(readyStore.getState().selectedFilePaths).sort();
    expect(selectedKeys).toEqual([
      encodeFileSelection('root', '/src/file1.txt'),
      encodeFileSelection('root', '/src/file2.txt'),
      encodeFileSelection('root', '/src/file3.txt'),
    ]);
    expect(directoryCheckbox).toHaveAttribute('data-state', 'checked');
  });

  it('routes a partially selected unloaded directory click to the recursive select, not removal', async () => {
    const unloadedTree: IFileNode[] = [
      {
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'lazy',
        path: '/lazy',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];
    const onSelectFolderRecursively = vi
      .fn<(node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>>()
      .mockResolvedValue({ filePaths: [], success: true });
    let fileExplorerStore: FileExplorerStore | undefined;

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={unloadedTree}
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
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(10);
      // A descendant selected under a collapsed, unloaded folder (e.g. from a
      // previous session) renders the folder indeterminate.
      readyStore.getState().addSelectedFile('root', '/lazy/known.ts');
      await Promise.resolve();
    });

    const directoryCheckbox = screen.getByLabelText('Select lazy');
    expect(directoryCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      fireEvent.click(directoryCheckbox);
    });

    // Completing the selection requires loading the folder: the click goes to
    // the recursive selector and the existing selection is preserved.
    expect(onSelectFolderRecursively).toHaveBeenCalledTimes(1);
    expect(
      readyStore.getState().selectedFilePaths.has(encodeFileSelection('root', '/lazy/known.ts'))
    ).toBe(true);
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'empty',
        path: '/empty',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
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
    const onSelectFolderRecursively = vi.fn(async () => ({ filePaths: [], success: true }));

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
    const onSelectFolderRecursively = vi.fn(async () => ({ filePaths: [], success: true }));

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
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: [],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-src-query',
          manifestSnapshotId: 'snapshot-src-query',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          directoryCounts: new Map([['/src', 2]]),
          errorMessage: null,
          filePaths: ['/src/file1.txt', '/src/file2.txt'],
          fingerprint: 'fp-src-query',
          pathSet: new Set(['/src/file1.txt', '/src/file2.txt']),
          snapshotId: 'snapshot-src-query',
          status: 'ready',
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

  it('continues recursive selection for a partially restored explicit directory (decision D1: mixed completes, never clears)', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const onSelectFolderRecursively = vi.fn(async () => ({ filePaths: [], success: true }));

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

    // The click completes the selection through the recursive selector (the
    // subtree is not fully loaded) and preserves the restored selection.
    expect(onSelectFolderRecursively).toHaveBeenCalledTimes(1);
    expect(readyStore.getState().selectedFilePaths).toEqual(new Set(['root|@|/src/file1.txt']));
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
