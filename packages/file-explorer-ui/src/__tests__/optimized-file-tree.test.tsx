import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, memoizedFileExplorer } from '@brainstrike/utils';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import * as fileTreeProviderModule from '../tree/file-tree-provider';
import OptimizedFileTree, {
  fileTreeTelemetry,
  resetFileTreeTelemetry,
} from '../tree/optimized-file-tree';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  listNormalizedDescendantFilePaths,
  materializeNormalizedSubtree,
} from '../utils/normalized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

type FileExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;

function StoreHandleBridge({ onStoreReady }: { onStoreReady: (store: FileExplorerStore) => void }) {
  const store = useFileExplorerStoreContext();
  useEffect(() => {
    onStoreReady(store);
  }, [onStoreReady, store]);
  return null;
}

describe('OptimizedFileTree', () => {
  const mockFileTree: IFileNode[] = [
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

  it('renders file tree container with correct attributes', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const container = screen.getByTestId('file-tree-scroll-container');
    expect(container).toBeInTheDocument();
    expect(container).toHaveClass('h-full', 'relative', 'flex-1', 'min-h-0', 'overflow-y-auto');
  });

  it('renders file tree with correct role and label', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
    expect(treeGrid).toBeInTheDocument();
  });

  it('opens a focused file row with keyboard activation', async () => {
    const openFileInTab = vi.fn();
    const uiModule = await import('@brainstrike/ui');
    const useIdeFileEditorSpy = vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab,
      registerOpenFileInTab: vi.fn(),
    });
    const fileOnlyTree: IFileNode[] = [
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

    try {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={fileOnlyTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );

      const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
      fireEvent.keyDown(treeGrid, { key: 'ArrowDown' });
      fireEvent.keyDown(treeGrid, { key: 'Enter' });

      expect(openFileInTab).toHaveBeenCalledWith(encodeFileSelection('root', '/test.txt'));
    } finally {
      useIdeFileEditorSpy.mockRestore();
    }
  });

  it('deduplicates child-load requests when expand is retriggered during loading', async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadChildren = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    render(
      <FileExplorerTestWrapper>
        <OptimizedFileTree
          fileTree={mockFileTree}
          folderId="root"
          loadingFiles={new Set()}
          onLoadChildren={onLoadChildren}
        />
      </FileExplorerTestWrapper>
    );

    const expandButton = screen.getByRole('button', { name: /expand/i });
    fireEvent.click(expandButton);
    fireEvent.click(expandButton);

    expect(onLoadChildren).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
  });

  it('does not materialize stale children when an expanded directory is not fully loaded', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const loadedDirectoryNode: IFileNode = {
      name: 'workspace',
      path: '/workspace',
      type: 'directory',
      isVisible: true,
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
      loadState: 'loaded',
      children: [
        {
          name: 'stale-child.ts',
          path: '/workspace/stale-child.ts',
          type: 'file',
          isVisible: true,
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
    };
    const loadedDirectoryTree: IFileNode[] = [loadedDirectoryNode];
    const loadingDirectoryTree: IFileNode[] = [
      {
        ...loadedDirectoryNode,
        loadState: 'loading',
      },
    ];

    const { rerender } = render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={loadedDirectoryTree}
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

    await act(async () => {
      readyStore.getState().toggleDirectoryExpansion('/workspace');
      await Promise.resolve();
    });
    expect(screen.getByText('stale-child.ts')).toBeInTheDocument();

    await act(async () => {
      rerender(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={loadingDirectoryTree}
            folderId="root"
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
    expect(screen.queryByText('stale-child.ts')).not.toBeInTheDocument();
  });

  it('does not render an unloaded persisted directory as expanded before its children are restored', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const unloadedTree: IFileNode[] = [
      {
        name: 'apps',
        path: '/apps',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
      },
    ];

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={unloadedTree} folderId="root" loadingFiles={new Set()} />
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
      readyStore.getState().setExpandedPaths(new Set(['/apps']));
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /collapse/i })).not.toBeInTheDocument();
  });

  it('updates visible file checkbox state after selection changes', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const fileCheckbox = screen.getByLabelText('Select test.txt');
    expect(fileCheckbox).not.toBeChecked();

    await act(async () => {
      fireEvent.click(fileCheckbox);
    });
    expect(fileCheckbox).toBeChecked();
  });

  it('updates directory checkbox state as nested selections change', async () => {
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

    const getDirectoryCheckbox = () => screen.getByLabelText('Select src');
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'unchecked');

    const readyStore = fileExplorerStore;
    if (!readyStore) {
      throw new Error('File explorer store is unavailable in test');
    }

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setMaxSelectionCount(10);
      await Promise.resolve();
    });

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(readyStore.getState().selectedFilePaths).toContain(
      encodeFileSelection('root', '/src/file1.txt')
    );
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file1.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      readyStore.getState().toggleSelectedFile('root', '/src/file2.txt');
      await Promise.resolve();
    });
    expect(getDirectoryCheckbox()).toHaveAttribute('data-state', 'unchecked');
  });

  it('promotes a parent directory from indeterminate to checked as child directories are selected one by one', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'e2e',
        path: '/e2e',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'page-objects',
            path: '/e2e/page-objects',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: 'file-explorer-page.ts',
                path: '/e2e/page-objects/file-explorer-page.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'types',
            path: '/e2e/types',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: 'performance.d.ts',
                path: '/e2e/types/performance.d.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'utils',
            path: '/e2e/utils',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: 'layout-helpers.ts',
                path: '/e2e/utils/layout-helpers.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
        ],
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
      await Promise.resolve();
    });

    await act(async () => {
      const e2eRow = screen.getByText('e2e').closest('tr');
      if (!e2eRow) {
        throw new Error('e2e row is unavailable in test');
      }
      fireEvent.click(within(e2eRow).getByRole('button', { name: 'Expand' }));
      await Promise.resolve();
    });

    const e2eCheckbox = screen.getByLabelText('Select e2e');
    const pageObjectsCheckbox = screen.getByLabelText('Select page-objects');
    const typesCheckbox = screen.getByLabelText('Select types');
    const utilsCheckbox = screen.getByLabelText('Select utils');

    expect(e2eCheckbox).toHaveAttribute('data-state', 'unchecked');

    await act(async () => {
      fireEvent.click(pageObjectsCheckbox);
      await Promise.resolve();
    });
    expect(pageObjectsCheckbox).toHaveAttribute('data-state', 'checked');
    expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      fireEvent.click(typesCheckbox);
      await Promise.resolve();
    });
    expect(typesCheckbox).toHaveAttribute('data-state', 'checked');
    expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await act(async () => {
      fireEvent.click(utilsCheckbox);
      await Promise.resolve();
    });
    expect(utilsCheckbox).toHaveAttribute('data-state', 'checked');
    expect(e2eCheckbox).toHaveAttribute('data-state', 'checked');
  });

  it('marks a query-selected directory checked when all direct files and child directories are selected', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'hooks',
        path: '/hooks',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'src',
            path: '/hooks/src',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: '__tests__',
                path: '/hooks/src/__tests__',
                type: 'directory',
                isVisible: true,
                handle: {} as FileSystemDirectoryHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
                loadState: 'unloaded',
              },
              {
                name: 'create-debounce.ts',
                path: '/hooks/src/create-debounce.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
              {
                name: 'index.ts',
                path: '/hooks/src/index.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'package.json',
            path: '/hooks/package.json',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'tsconfig.json',
            path: '/hooks/tsconfig.json',
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
      readyStore.getState().setQuerySelection(
        {
          kind: 'recursive-select-all',
          folderId: 'root',
          rootPath: null,
          coveredDirectoryPaths: ['/hooks', '/hooks/src', '/hooks/src/__tests__'],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-hooks',
          manifestSnapshotId: 'snapshot-hooks',
          totalSelectedCount: 5,
          useRegex: false,
        },
        {
          filePaths: [
            '/hooks/src/__tests__/use-file-filters.test.ts',
            '/hooks/src/create-debounce.ts',
            '/hooks/src/index.ts',
            '/hooks/package.json',
            '/hooks/tsconfig.json',
          ],
          pathSet: new Set([
            '/hooks/src/__tests__/use-file-filters.test.ts',
            '/hooks/src/create-debounce.ts',
            '/hooks/src/index.ts',
            '/hooks/package.json',
            '/hooks/tsconfig.json',
          ]),
          directoryCounts: new Map([
            ['/hooks', 5],
            ['/hooks/src', 3],
            ['/hooks/src/__tests__', 1],
          ]),
          fingerprint: 'fp-hooks',
          snapshotId: 'snapshot-hooks',
          status: 'ready',
          errorMessage: null,
        },
        new Set([
          '/hooks/src/__tests__/use-file-filters.test.ts',
          '/hooks/src/create-debounce.ts',
          '/hooks/src/index.ts',
          '/hooks/package.json',
          '/hooks/tsconfig.json',
        ])
      );
      readyStore.getState().toggleDirectoryExpansion('/hooks');
      readyStore.getState().toggleDirectoryExpansion('/hooks/src');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select __tests__')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select hooks')).toHaveAttribute('data-state', 'checked');
  });

  it('marks explicitly restored mixed file-and-folder directories checked when all descendants are selected', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'hooks',
        path: '/packages/hooks',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: '.turbo',
            path: '/packages/hooks/.turbo',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: 'turbo-build.log',
                path: '/packages/hooks/.turbo/turbo-build.log',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
              {
                name: 'turbo-test.log',
                path: '/packages/hooks/.turbo/turbo-test.log',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
              {
                name: 'turbo-type-check.log',
                path: '/packages/hooks/.turbo/turbo-type-check.log',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'src',
            path: '/packages/hooks/src',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: '__tests__',
                path: '/packages/hooks/src/__tests__',
                type: 'directory',
                isVisible: true,
                handle: {} as FileSystemDirectoryHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
                loadState: 'loaded',
                children: [
                  {
                    name: 'create-debounce.test.ts',
                    path: '/packages/hooks/src/__tests__/create-debounce.test.ts',
                    type: 'file',
                    isVisible: true,
                    handle: {} as FileSystemFileHandle,
                    depth: 3,
                    selectionState: 'unchecked',
                    rootFolderId: 'root',
                  },
                  {
                    name: 'use-debounced-value.test.tsx',
                    path: '/packages/hooks/src/__tests__/use-debounced-value.test.tsx',
                    type: 'file',
                    isVisible: true,
                    handle: {} as FileSystemFileHandle,
                    depth: 3,
                    selectionState: 'unchecked',
                    rootFolderId: 'root',
                  },
                  {
                    name: 'use-file-filters.test.ts',
                    path: '/packages/hooks/src/__tests__/use-file-filters.test.ts',
                    type: 'file',
                    isVisible: true,
                    handle: {} as FileSystemFileHandle,
                    depth: 3,
                    selectionState: 'unchecked',
                    rootFolderId: 'root',
                  },
                ],
              },
              {
                name: 'create-debounce.ts',
                path: '/packages/hooks/src/create-debounce.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
              {
                name: 'index.ts',
                path: '/packages/hooks/src/index.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'package.json',
            path: '/packages/hooks/package.json',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'tsconfig.json',
            path: '/packages/hooks/tsconfig.json',
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'tsup.config.ts',
            path: '/packages/hooks/tsup.config.ts',
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
      readyStore
        .getState()
        .setSelectedFiles(
          new Set([
            encodeFileSelection('root', '/packages/hooks/.turbo/turbo-build.log'),
            encodeFileSelection('root', '/packages/hooks/.turbo/turbo-test.log'),
            encodeFileSelection('root', '/packages/hooks/.turbo/turbo-type-check.log'),
            encodeFileSelection('root', '/packages/hooks/src/__tests__/create-debounce.test.ts'),
            encodeFileSelection(
              'root',
              '/packages/hooks/src/__tests__/use-debounced-value.test.tsx'
            ),
            encodeFileSelection('root', '/packages/hooks/src/__tests__/use-file-filters.test.ts'),
            encodeFileSelection('root', '/packages/hooks/src/create-debounce.ts'),
            encodeFileSelection('root', '/packages/hooks/src/index.ts'),
            encodeFileSelection('root', '/packages/hooks/package.json'),
            encodeFileSelection('root', '/packages/hooks/tsconfig.json'),
            encodeFileSelection('root', '/packages/hooks/tsup.config.ts'),
          ])
        );
      readyStore.getState().toggleDirectoryExpansion('/packages/hooks');
      readyStore.getState().toggleDirectoryExpansion('/packages/hooks/src');
      readyStore.getState().toggleDirectoryExpansion('/packages/hooks/src/__tests__');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select .turbo')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select __tests__')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select hooks')).toHaveAttribute('data-state', 'checked');
  });

  it('keeps explicit parent directories checked on the normalized tree path when loaded child directories are fully selected', async () => {
    const loadedTree: IFileNode[] = [
      {
        name: 'hooks',
        path: '/packages/hooks',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'src',
            path: '/packages/hooks/src',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'loaded',
            children: [
              {
                name: '__tests__',
                path: '/packages/hooks/src/__tests__',
                type: 'directory',
                isVisible: true,
                handle: {} as FileSystemDirectoryHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
                loadState: 'loaded',
                children: [
                  {
                    name: 'use-file-filters.test.ts',
                    path: '/packages/hooks/src/__tests__/use-file-filters.test.ts',
                    type: 'file',
                    isVisible: true,
                    handle: {} as FileSystemFileHandle,
                    depth: 3,
                    selectionState: 'unchecked',
                    rootFolderId: 'root',
                  },
                ],
              },
              {
                name: 'create-debounce.ts',
                path: '/packages/hooks/src/create-debounce.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
              {
                name: 'index.ts',
                path: '/packages/hooks/src/index.ts',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
          {
            name: 'package.json',
            path: '/packages/hooks/package.json',
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
    const normalizedState = createNormalizedFileTreeState(loadedTree);
    const normalizedContextSpy = vi
      .spyOn(fileTreeProviderModule, 'useOptionalFileTreeNormalizedContext')
      .mockReturnValue({
        normalizedTreeRef: { current: normalizedState },
        version: 1,
        getDescendantFileCount: (path: string) =>
          getNormalizedDescendantFileCount(normalizedState, path),
        getDescendantFilePaths: (path: string, maxCount?: number) =>
          listNormalizedDescendantFilePaths(normalizedState, path, maxCount),
        materializeSubtree: (path: string) => materializeNormalizedSubtree(normalizedState, path),
      });

    let fileExplorerStore: FileExplorerStore | undefined;

    try {
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
        readyStore
          .getState()
          .setSelectedFiles(
            new Set([
              encodeFileSelection('root', '/packages/hooks/src/__tests__/use-file-filters.test.ts'),
              encodeFileSelection('root', '/packages/hooks/src/create-debounce.ts'),
              encodeFileSelection('root', '/packages/hooks/src/index.ts'),
              encodeFileSelection('root', '/packages/hooks/package.json'),
            ])
          );
        readyStore
          .getState()
          .setExpandedPaths(
            new Set(['/packages/hooks', '/packages/hooks/src', '/packages/hooks/src/__tests__'])
          );
        await Promise.resolve();
      });

      expect(screen.getByLabelText('Select __tests__')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Select hooks')).toHaveAttribute('data-state', 'checked');
    } finally {
      normalizedContextSpy.mockRestore();
    }
  });

  it('marks query-selected root directories as checked even before descendant counts load', async () => {
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
      },
      {
        name: 'docs',
        path: '/docs',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
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

    await act(async () => {
      readyStore.getState().setQuerySelection(
        {
          kind: 'recursive-select-all',
          folderId: 'root',
          rootPath: null,
          coveredDirectoryPaths: ['/src', '/docs'],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 10,
          useRegex: false,
        },
        {
          filePaths: ['/src/file1.ts', '/docs/readme.md'],
          pathSet: new Set(['/src/file1.ts', '/docs/readme.md']),
          directoryCounts: new Map([
            ['/src', 1],
            ['/docs', 1],
          ]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
        new Set(['/src/file1.ts', '/docs/readme.md'])
      );
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select docs')).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
  });

  it('does not mark directories checked in query mode when they are outside the covered filtered paths', async () => {
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
        children: [],
      },
      {
        name: 'docs',
        path: '/docs',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
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

    await act(async () => {
      readyStore.getState().setQuerySelection(
        {
          kind: 'recursive-select-all',
          folderId: 'root',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-2',
          manifestSnapshotId: 'snapshot-2',
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          status: 'ready',
          errorMessage: null,
        },
        new Set(['/src/index.ts'])
      );
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select docs')).toHaveAttribute('data-state', 'unchecked');

    await act(async () => {
      readyStore.getState().clearSelectedFiles();
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
  });

  it('marks unloaded directories indeterminate when explicit selected descendants exist', async () => {
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
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

    await act(async () => {
      readyStore
        .getState()
        .setSelectedFiles(new Set([encodeFileSelection('root', '/src/index.ts')]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'indeterminate');
  });

  it('marks absolute workspace parents indeterminate from agent-selected relative descendants', async () => {
    const rootPath = '/Users/test/project';
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'project',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
          folderId={rootPath}
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

    await act(async () => {
      readyStore
        .getState()
        .setSelectedFiles(new Set([encodeFileSelection(rootPath, '/src/index.ts')]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select project')).toHaveAttribute('data-state', 'indeterminate');
  });

  it('marks an absolute workspace root checked from an agent-selected root path', async () => {
    const rootPath = '/Users/test/project-root-only';
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'project-root-only',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
          folderId={rootPath}
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

    await act(async () => {
      readyStore.getState().setSelectedFiles(new Set([encodeFileSelection(rootPath, '/')]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select project-root-only')).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('clears agent-selected relative descendants when toggling an absolute workspace root', async () => {
    const rootPath = '/Users/test/project-clear-root';
    const relativeSelectionKey = encodeFileSelection(rootPath, '/src/index.ts');
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'project-clear-root',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
          folderId={rootPath}
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

    await act(async () => {
      readyStore.getState().setSelectedFiles(new Set([relativeSelectionKey]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select project-clear-root'));
      await Promise.resolve();
    });

    expect(readyStore.getState().selectedFilePaths).toEqual(new Set());
  });

  it('marks hydrated absolute file rows checked from agent-selected relative descendants', async () => {
    const rootPath = '/Users/test/project';
    const loadedTree: IFileNode[] = [
      {
        name: 'project',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'loaded',
        children: [
          {
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
          },
        ],
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
        <OptimizedFileTree fileTree={loadedTree} folderId={rootPath} loadingFiles={new Set()} />
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
      readyStore
        .getState()
        .setSelectedFiles(new Set([encodeFileSelection(rootPath, '/src/index.ts')]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Expand'));
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select index.ts')).toHaveAttribute('data-state', 'checked');
  });

  it('marks hydrated Windows absolute file rows checked from agent-selected relative descendants', async () => {
    const rootPath = 'C:\\Users\\test\\project';
    const loadedTree: IFileNode[] = [
      {
        name: 'project',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'loaded',
        children: [
          {
            name: 'index.ts',
            path: `${rootPath}\\src\\index.ts`,
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
          },
        ],
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
        <OptimizedFileTree fileTree={loadedTree} folderId={rootPath} loadingFiles={new Set()} />
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
      readyStore
        .getState()
        .setSelectedFiles(new Set([encodeFileSelection(rootPath, '/src/index.ts')]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Expand'));
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select index.ts')).toHaveAttribute('data-state', 'checked');
  });

  it('removes the relative selected key when toggling a checked absolute file row', async () => {
    const rootPath = '/Users/test/project-toggle';
    const relativeSelectionKey = encodeFileSelection(rootPath, '/src/index.ts');
    const loadedTree: IFileNode[] = [
      {
        name: 'project',
        path: rootPath,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'loaded',
        children: [
          {
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            type: 'file',
            isVisible: true,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
          },
        ],
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
        <OptimizedFileTree fileTree={loadedTree} folderId={rootPath} loadingFiles={new Set()} />
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
      readyStore.getState().setSelectedFiles(new Set([relativeSelectionKey]));
      readyStore.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Expand'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select index.ts'));
      await Promise.resolve();
    });

    expect(readyStore.getState().selectedFilePaths).toEqual(new Set());
  });

  it('does not treat shared string prefixes as ancestors of the query root', async () => {
    const partiallyLoadedTree: IFileNode[] = [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
      },
      {
        name: 'src-generated',
        path: '/src-generated',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
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
          fileTree={partiallyLoadedTree}
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

    await act(async () => {
      readyStore.getState().setQuerySelection(
        {
          kind: 'recursive-folder',
          folderId: 'root',
          rootPath: '/src-generated',
          coveredDirectoryPaths: ['/src-generated'],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-src-generated',
          manifestSnapshotId: 'snapshot-src-generated',
          totalSelectedCount: 1,
          useRegex: false,
        },
        {
          filePaths: ['/src-generated/index.ts'],
          pathSet: new Set(['/src-generated/index.ts']),
          directoryCounts: new Map([['/src-generated', 1]]),
          fingerprint: 'fp-src-generated',
          snapshotId: 'snapshot-src-generated',
          status: 'ready',
          errorMessage: null,
        },
        new Set(['/src-generated/index.ts'])
      );
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Select src-generated')).toHaveAttribute('data-state', 'checked');
  });

  it('preserves a query-selected parent checkbox state when expanding via the chevron loads children', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    let resolveLoadChildren: (() => void) | undefined;

    const initialTree: IFileNode[] = [
      {
        name: 'packages',
        path: '/packages',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'unloaded',
      },
    ];

    const loadedTree: IFileNode[] = [
      {
        name: 'packages',
        path: '/packages',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        loadState: 'loaded',
        children: [
          {
            name: 'agent',
            path: '/packages/agent',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'unloaded',
          },
          {
            name: 'app-shell',
            path: '/packages/app-shell',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            loadState: 'unloaded',
          },
        ],
      },
    ];

    const onLoadChildren = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoadChildren = resolve;
        })
    );

    const { rerender } = render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree
          fileTree={initialTree}
          folderId="root"
          loadingFiles={new Set()}
          onLoadChildren={onLoadChildren}
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
          coveredDirectoryPaths: ['/packages', '/packages/agent', '/packages/app-shell'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-packages',
          manifestSnapshotId: 'snapshot-packages',
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          filePaths: ['/packages/agent/index.ts', '/packages/app-shell/app.ts'],
          pathSet: new Set(['/packages/agent/index.ts', '/packages/app-shell/app.ts']),
          directoryCounts: new Map([
            ['/packages', 2],
            ['/packages/agent', 1],
            ['/packages/app-shell', 1],
          ]),
          fingerprint: 'fp-packages',
          snapshotId: 'snapshot-packages',
          status: 'ready',
          errorMessage: null,
        },
        new Set(['/packages/agent/index.ts', '/packages/app-shell/app.ts'])
      );
      await Promise.resolve();
    });

    const packagesCheckbox = screen.getByLabelText('Select packages');
    expect(packagesCheckbox).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    });
    expect(onLoadChildren).toHaveBeenCalledWith('/packages');

    await act(async () => {
      resolveLoadChildren?.();
      rerender(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={loadedTree}
            folderId="root"
            loadingFiles={new Set()}
            onLoadChildren={onLoadChildren}
          />
        </FileExplorerTestWrapper>
      );
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select packages')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select agent')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select app-shell')).toHaveAttribute('data-state', 'checked');
  });

  it('preserves a query-selected desktop-style absolute parent checkbox state after expansion', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const rootPath = '/mock/desktop-selection-root-packages';

    const loadedTree: IFileNode[] = [
      {
        name: 'docs',
        path: `${rootPath}/docs`,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'unloaded',
      },
      {
        name: 'packages',
        path: `${rootPath}/packages`,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'loaded',
        children: [
          {
            name: 'agent',
            path: `${rootPath}/packages/agent`,
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
            loadState: 'unloaded',
          },
          {
            name: 'app-shell',
            path: `${rootPath}/packages/app-shell`,
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
            loadState: 'unloaded',
          },
        ],
      },
    ];

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={loadedTree} folderId={rootPath} loadingFiles={new Set()} />
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
          folderId: rootPath,
          rootPath: null,
          coveredDirectoryPaths: [
            '/mock',
            rootPath,
            `${rootPath}/packages`,
            `${rootPath}/packages/agent`,
            `${rootPath}/packages/app-shell`,
          ],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-desktop-packages',
          manifestSnapshotId: 'snapshot-desktop-packages',
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          filePaths: [
            `${rootPath}/packages/agent/index.ts`,
            `${rootPath}/packages/app-shell/main.ts`,
          ],
          pathSet: new Set([
            `${rootPath}/packages/agent/index.ts`,
            `${rootPath}/packages/app-shell/main.ts`,
          ]),
          directoryCounts: new Map([
            ['/mock', 2],
            [rootPath, 2],
            [`${rootPath}/packages`, 2],
            [`${rootPath}/packages/agent`, 1],
            [`${rootPath}/packages/app-shell`, 1],
          ]),
          fingerprint: 'fp-desktop-packages',
          snapshotId: 'snapshot-desktop-packages',
          status: 'ready',
          errorMessage: null,
        },
        new Set([`${rootPath}/packages/agent/index.ts`, `${rootPath}/packages/app-shell/main.ts`])
      );
      readyStore.getState().toggleDirectoryExpansion(`${rootPath}/packages`);
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select packages')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select agent')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select app-shell')).toHaveAttribute('data-state', 'checked');
  });

  it('marks manually included sibling directories checked in query mode after expansion', async () => {
    let fileExplorerStore: FileExplorerStore | undefined;
    const rootPath = '/mock/desktop-selection-root-e2e';

    const loadedTree: IFileNode[] = [
      {
        name: 'e2e',
        path: `${rootPath}/e2e`,
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: rootPath,
        loadState: 'loaded',
        children: [
          {
            name: 'page-objects',
            path: `${rootPath}/e2e/page-objects`,
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
            loadState: 'loaded',
            children: [
              {
                name: 'file-explorer-page.ts',
                path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: rootPath,
              },
            ],
          },
          {
            name: 'types',
            path: `${rootPath}/e2e/types`,
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: rootPath,
            loadState: 'loaded',
            children: [
              {
                name: 'performance.ts',
                path: `${rootPath}/e2e/types/performance.ts`,
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: rootPath,
              },
            ],
          },
        ],
      },
    ];

    render(
      <FileExplorerTestWrapper>
        <StoreHandleBridge
          onStoreReady={(store) => {
            fileExplorerStore = store;
          }}
        />
        <OptimizedFileTree fileTree={loadedTree} folderId={rootPath} loadingFiles={new Set()} />
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
          kind: 'recursive-folder',
          folderId: rootPath,
          rootPath: `${rootPath}/e2e/page-objects`,
          coveredDirectoryPaths: [
            rootPath,
            `${rootPath}/e2e`,
            `${rootPath}/e2e/page-objects`,
            `${rootPath}/e2e/types`,
          ],
          includeFilters: [],
          excludeFilters: [],
          includedPaths: [`${rootPath}/e2e/types/performance.ts`],
          excludedPaths: [],
          manifestFingerprint: 'fp-desktop-e2e',
          manifestSnapshotId: 'snapshot-desktop-e2e',
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          filePaths: [`${rootPath}/e2e/page-objects/file-explorer-page.ts`],
          pathSet: new Set([`${rootPath}/e2e/page-objects/file-explorer-page.ts`]),
          directoryCounts: new Map([
            [rootPath, 1],
            [`${rootPath}/e2e`, 1],
            [`${rootPath}/e2e/page-objects`, 1],
          ]),
          fingerprint: 'fp-desktop-e2e',
          snapshotId: 'snapshot-desktop-e2e',
          status: 'ready',
          errorMessage: null,
        },
        new Set([
          `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
          `${rootPath}/e2e/types/performance.ts`,
        ])
      );
      readyStore.getState().toggleDirectoryExpansion(`${rootPath}/e2e`);
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select page-objects')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select types')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select e2e')).toHaveAttribute('data-state', 'checked');
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

  it('calls onRender callback when provided', async () => {
    const mockOnRender = vi.fn();

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={mockFileTree}
            folderId="root"
            loadingFiles={new Set()}
            onRender={mockOnRender}
          />
        </FileExplorerTestWrapper>
      );
    });

    expect(mockOnRender).toHaveBeenCalled();
  });

  it('renders empty tree when fileTree is empty', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={[]} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('applies correct classes to tree container', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' });
    expect(treeGrid).toHaveClass('file-tree');
  });

  it('renders with loading files set', async () => {
    const loadingFiles = new Set(['root:/src/file1.txt']);

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={loadingFiles} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles folderId changes', async () => {
    let rerenderFn: ReturnType<typeof render>['rerender'];

    await act(async () => {
      const result = render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
      rerenderFn = result.rerender;
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();

    await act(async () => {
      rerenderFn!(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="other" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('does not call onRender when not provided', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles fileTree updates', async () => {
    let rerenderFn: ReturnType<typeof render>['rerender'];

    await act(async () => {
      const result = render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
      rerenderFn = result.rerender;
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();

    const newFileTree: IFileNode[] = [
      {
        name: 'new-file.txt',
        path: '/new-file.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
    ];

    await act(async () => {
      rerenderFn!(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={newFileTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('renders with invisible nodes filtered out', async () => {
    const treeWithInvisible: IFileNode[] = [
      {
        name: 'visible',
        path: '/visible',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'invisible.txt',
            path: '/visible/invisible.txt',
            type: 'file',
            isVisible: false,
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
    ];

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            fileTree={treeWithInvisible}
            folderId="root"
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('handles nested directory structure', async () => {
    const nestedTree: IFileNode[] = [
      {
        name: 'level1',
        path: '/level1',
        type: 'directory',
        isVisible: true,
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'level2',
            path: '/level1/level2',
            type: 'directory',
            isVisible: true,
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            children: [
              {
                name: 'deep-file.txt',
                path: '/level1/level2/deep-file.txt',
                type: 'file',
                isVisible: true,
                handle: {} as FileSystemFileHandle,
                depth: 2,
                selectionState: 'unchecked',
                rootFolderId: 'root',
              },
            ],
          },
        ],
      },
    ];

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree fileTree={nestedTree} folderId="root" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  describe('performance: columns stability', () => {
    it('should NOT rebuild columns when a file is selected', async () => {
      let fileExplorerStore: FileExplorerStore | null = null;

      await act(async () => {
        render(
          <StrictMode>
            <FileExplorerTestWrapper>
              <StoreHandleBridge
                onStoreReady={(store) => {
                  fileExplorerStore = store;
                }}
              />
              <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
            </FileExplorerTestWrapper>
          </StrictMode>
        );
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(fileExplorerStore).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
      const store = fileExplorerStore!;

      await act(async () => {
        store.getState().clearSelectedFiles();
        store.getState().setMaxSelectionCount(10);
        await Promise.resolve();
      });

      // Reset telemetry AFTER initial render settles
      resetFileTreeTelemetry();

      // Select a file via store (simulates clicking a checkbox)
      await act(async () => {
        store.getState().toggleSelectedFile('root', '/test.txt');
        await Promise.resolve();
      });

      // treeRows should NOT rebuild on selection change
      expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(0);

      // columns should NOT rebuild on selection change — selection state
      // is delivered via FileTreeSelectionContext, not column closures
      expect(fileTreeTelemetry.columnsRebuildCount).toBe(0);
    });
  });

  describe('opening files via row click (VS Code semantics)', () => {
    it('clicking a file row opens it in a workspace tab', async () => {
      const uiModule = await import('@brainstrike/ui');
      const openFileInTab = vi.fn();
      vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
        openFileInTab,
        registerOpenFileInTab: vi.fn(),
      });

      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const fileLabel = await screen.findByText('test.txt');
      await act(async () => {
        fireEvent.click(fileLabel);
      });

      expect(openFileInTab).toHaveBeenCalledTimes(1);
      expect(openFileInTab).toHaveBeenCalledWith(encodeFileSelection('root', '/test.txt'));
    });

    it('clicking a directory row does NOT open a tab', async () => {
      const uiModule = await import('@brainstrike/ui');
      const openFileInTab = vi.fn();
      vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
        openFileInTab,
        registerOpenFileInTab: vi.fn(),
      });

      await act(async () => {
        render(
          <FileExplorerTestWrapper>
            <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
          </FileExplorerTestWrapper>
        );
      });

      const dirLabel = await screen.findByText('src');
      await act(async () => {
        fireEvent.click(dirLabel);
      });

      expect(openFileInTab).not.toHaveBeenCalled();
    });
  });
});
