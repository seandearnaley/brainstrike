import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as fileTreeProviderModule from '../tree/file-tree-provider';
import OptimizedFileTree from '../tree/optimized-file-tree';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  listNormalizedDescendantFilePaths,
  materializeNormalizedSubtree,
} from '../utils/normalized-file-tree';
import {
  type FileExplorerStore,
  mockFileTree,
  StoreHandleBridge,
} from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

describe('OptimizedFileTree selection states', () => {
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
        children: [
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'file-explorer-page.ts',
                path: '/e2e/page-objects/file-explorer-page.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'page-objects',
            path: '/e2e/page-objects',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'performance.d.ts',
                path: '/e2e/types/performance.d.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'types',
            path: '/e2e/types',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'layout-helpers.ts',
                path: '/e2e/utils/layout-helpers.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'utils',
            path: '/e2e/utils',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'e2e',
        path: '/e2e',
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
        children: [
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemDirectoryHandle,
                isVisible: true,
                loadState: 'unloaded',
                name: '__tests__',
                path: '/hooks/src/__tests__',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'directory',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'create-debounce.ts',
                path: '/hooks/src/create-debounce.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'index.ts',
                path: '/hooks/src/index.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'src',
            path: '/hooks/src',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'package.json',
            path: '/hooks/package.json',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'tsconfig.json',
            path: '/hooks/tsconfig.json',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'hooks',
        path: '/hooks',
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
      readyStore.getState().setQuerySelection(
        {
          coveredDirectoryPaths: ['/hooks', '/hooks/src', '/hooks/src/__tests__'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: [],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-hooks',
          manifestSnapshotId: 'snapshot-hooks',
          rootPath: null,
          totalSelectedCount: 5,
          useRegex: false,
        },
        {
          directoryCounts: new Map([
            ['/hooks', 5],
            ['/hooks/src', 3],
            ['/hooks/src/__tests__', 1],
          ]),
          errorMessage: null,
          filePaths: [
            '/hooks/src/__tests__/use-file-filters.test.ts',
            '/hooks/src/create-debounce.ts',
            '/hooks/src/index.ts',
            '/hooks/package.json',
            '/hooks/tsconfig.json',
          ],
          fingerprint: 'fp-hooks',
          pathSet: new Set([
            '/hooks/src/__tests__/use-file-filters.test.ts',
            '/hooks/src/create-debounce.ts',
            '/hooks/src/index.ts',
            '/hooks/package.json',
            '/hooks/tsconfig.json',
          ]),
          snapshotId: 'snapshot-hooks',
          status: 'ready',
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
        children: [
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'turbo-build.log',
                path: '/packages/hooks/.turbo/turbo-build.log',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'turbo-test.log',
                path: '/packages/hooks/.turbo/turbo-test.log',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'turbo-type-check.log',
                path: '/packages/hooks/.turbo/turbo-type-check.log',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: '.turbo',
            path: '/packages/hooks/.turbo',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            children: [
              {
                children: [
                  {
                    depth: 3,
                    handle: {} as FileSystemFileHandle,
                    isVisible: true,
                    name: 'create-debounce.test.ts',
                    path: '/packages/hooks/src/__tests__/create-debounce.test.ts',
                    rootFolderId: 'root',
                    selectionState: 'unchecked',
                    type: 'file',
                  },
                  {
                    depth: 3,
                    handle: {} as FileSystemFileHandle,
                    isVisible: true,
                    name: 'use-debounced-value.test.tsx',
                    path: '/packages/hooks/src/__tests__/use-debounced-value.test.tsx',
                    rootFolderId: 'root',
                    selectionState: 'unchecked',
                    type: 'file',
                  },
                  {
                    depth: 3,
                    handle: {} as FileSystemFileHandle,
                    isVisible: true,
                    name: 'use-file-filters.test.ts',
                    path: '/packages/hooks/src/__tests__/use-file-filters.test.ts',
                    rootFolderId: 'root',
                    selectionState: 'unchecked',
                    type: 'file',
                  },
                ],
                depth: 2,
                handle: {} as FileSystemDirectoryHandle,
                isVisible: true,
                loadState: 'loaded',
                name: '__tests__',
                path: '/packages/hooks/src/__tests__',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'directory',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'create-debounce.ts',
                path: '/packages/hooks/src/create-debounce.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'index.ts',
                path: '/packages/hooks/src/index.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'src',
            path: '/packages/hooks/src',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'package.json',
            path: '/packages/hooks/package.json',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'tsconfig.json',
            path: '/packages/hooks/tsconfig.json',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'tsup.config.ts',
            path: '/packages/hooks/tsup.config.ts',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'hooks',
        path: '/packages/hooks',
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
        children: [
          {
            children: [
              {
                children: [
                  {
                    depth: 3,
                    handle: {} as FileSystemFileHandle,
                    isVisible: true,
                    name: 'use-file-filters.test.ts',
                    path: '/packages/hooks/src/__tests__/use-file-filters.test.ts',
                    rootFolderId: 'root',
                    selectionState: 'unchecked',
                    type: 'file',
                  },
                ],
                depth: 2,
                handle: {} as FileSystemDirectoryHandle,
                isVisible: true,
                loadState: 'loaded',
                name: '__tests__',
                path: '/packages/hooks/src/__tests__',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'directory',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'create-debounce.ts',
                path: '/packages/hooks/src/create-debounce.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'index.ts',
                path: '/packages/hooks/src/index.ts',
                rootFolderId: 'root',
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'src',
            path: '/packages/hooks/src',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'package.json',
            path: '/packages/hooks/package.json',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'hooks',
        path: '/packages/hooks',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];
    const normalizedState = createNormalizedFileTreeState(loadedTree);
    const normalizedContextSpy = vi
      .spyOn(fileTreeProviderModule, 'useOptionalFileTreeNormalizedContext')
      .mockReturnValue({
        getDescendantFileCount: (path: string) =>
          getNormalizedDescendantFileCount(normalizedState, path),
        getDescendantFilePaths: (path: string, maxCount?: number) =>
          listNormalizedDescendantFilePaths(normalizedState, path, maxCount),
        materializeSubtree: (path: string) => materializeNormalizedSubtree(normalizedState, path),
        normalizedTreeRef: { current: normalizedState },
        version: 1,
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
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'src',
        path: '/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
      {
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'docs',
        path: '/docs',
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
          coveredDirectoryPaths: ['/src', '/docs'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: [],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 10,
          useRegex: false,
        },
        {
          directoryCounts: new Map([
            ['/src', 1],
            ['/docs', 1],
          ]),
          errorMessage: null,
          filePaths: ['/src/file1.ts', '/docs/readme.md'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/file1.ts', '/docs/readme.md']),
          snapshotId: 'snapshot-1',
          status: 'ready',
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'src',
        path: '/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
      {
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'docs',
        path: '/docs',
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
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-2',
          manifestSnapshotId: 'snapshot-2',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/index.ts'],
          fingerprint: 'fp-2',
          pathSet: new Set(['/src/index.ts']),
          snapshotId: 'snapshot-2',
          status: 'ready',
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'project',
        path: rootPath,
        rootFolderId: rootPath,
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'project-root-only',
        path: rootPath,
        rootFolderId: rootPath,
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
        children: [],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'project-clear-root',
        path: rootPath,
        rootFolderId: rootPath,
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
        children: [
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'project',
        path: rootPath,
        rootFolderId: rootPath,
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
        children: [
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'index.ts',
            path: `${rootPath}\\src\\index.ts`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'project',
        path: rootPath,
        rootFolderId: rootPath,
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
        children: [
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            isVisible: true,
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'project',
        path: rootPath,
        rootFolderId: rootPath,
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
});
