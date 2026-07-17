import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { type FileExplorerStore, StoreHandleBridge } from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

describe('OptimizedFileTree query expansion states', () => {
  it('does not treat shared string prefixes as ancestors of the query root', async () => {
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
        name: 'src-generated',
        path: '/src-generated',
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
          coveredDirectoryPaths: ['/src-generated'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: [],
          kind: 'recursive-folder',
          manifestFingerprint: 'fp-src-generated',
          manifestSnapshotId: 'snapshot-src-generated',
          rootPath: '/src-generated',
          totalSelectedCount: 1,
          useRegex: false,
        },
        {
          directoryCounts: new Map([['/src-generated', 1]]),
          errorMessage: null,
          filePaths: ['/src-generated/index.ts'],
          fingerprint: 'fp-src-generated',
          pathSet: new Set(['/src-generated/index.ts']),
          snapshotId: 'snapshot-src-generated',
          status: 'ready',
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
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'packages',
        path: '/packages',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ];

    const loadedTree: IFileNode[] = [
      {
        children: [
          {
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'unloaded',
            name: 'agent',
            path: '/packages/agent',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'unloaded',
            name: 'app-shell',
            path: '/packages/app-shell',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'packages',
        path: '/packages',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
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
          coveredDirectoryPaths: ['/packages', '/packages/agent', '/packages/app-shell'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'root',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-packages',
          manifestSnapshotId: 'snapshot-packages',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          directoryCounts: new Map([
            ['/packages', 2],
            ['/packages/agent', 1],
            ['/packages/app-shell', 1],
          ]),
          errorMessage: null,
          filePaths: ['/packages/agent/index.ts', '/packages/app-shell/app.ts'],
          fingerprint: 'fp-packages',
          pathSet: new Set(['/packages/agent/index.ts', '/packages/app-shell/app.ts']),
          snapshotId: 'snapshot-packages',
          status: 'ready',
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
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'unloaded',
        name: 'docs',
        path: `${rootPath}/docs`,
        rootFolderId: rootPath,
        selectionState: 'unchecked',
        type: 'directory',
      },
      {
        children: [
          {
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'unloaded',
            name: 'agent',
            path: `${rootPath}/packages/agent`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'unloaded',
            name: 'app-shell',
            path: `${rootPath}/packages/app-shell`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'directory',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'packages',
        path: `${rootPath}/packages`,
        rootFolderId: rootPath,
        selectionState: 'unchecked',
        type: 'directory',
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
          coveredDirectoryPaths: [
            '/mock',
            rootPath,
            `${rootPath}/packages`,
            `${rootPath}/packages/agent`,
            `${rootPath}/packages/app-shell`,
          ],
          excludedPaths: [],
          excludeFilters: [],
          folderId: rootPath,
          includedPaths: [],
          includeFilters: [],
          kind: 'recursive-select-all',
          manifestFingerprint: 'fp-desktop-packages',
          manifestSnapshotId: 'snapshot-desktop-packages',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          directoryCounts: new Map([
            ['/mock', 2],
            [rootPath, 2],
            [`${rootPath}/packages`, 2],
            [`${rootPath}/packages/agent`, 1],
            [`${rootPath}/packages/app-shell`, 1],
          ]),
          errorMessage: null,
          filePaths: [
            `${rootPath}/packages/agent/index.ts`,
            `${rootPath}/packages/app-shell/main.ts`,
          ],
          fingerprint: 'fp-desktop-packages',
          pathSet: new Set([
            `${rootPath}/packages/agent/index.ts`,
            `${rootPath}/packages/app-shell/main.ts`,
          ]),
          snapshotId: 'snapshot-desktop-packages',
          status: 'ready',
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
        children: [
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'file-explorer-page.ts',
                path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
                rootFolderId: rootPath,
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'page-objects',
            path: `${rootPath}/e2e/page-objects`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            children: [
              {
                depth: 2,
                handle: {} as FileSystemFileHandle,
                isVisible: true,
                name: 'performance.ts',
                path: `${rootPath}/e2e/types/performance.ts`,
                rootFolderId: rootPath,
                selectionState: 'unchecked',
                type: 'file',
              },
            ],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            isVisible: true,
            loadState: 'loaded',
            name: 'types',
            path: `${rootPath}/e2e/types`,
            rootFolderId: rootPath,
            selectionState: 'unchecked',
            type: 'directory',
          },
        ],
        depth: 0,
        handle: {} as FileSystemDirectoryHandle,
        isVisible: true,
        loadState: 'loaded',
        name: 'e2e',
        path: `${rootPath}/e2e`,
        rootFolderId: rootPath,
        selectionState: 'unchecked',
        type: 'directory',
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
          coveredDirectoryPaths: [
            rootPath,
            `${rootPath}/e2e`,
            `${rootPath}/e2e/page-objects`,
            `${rootPath}/e2e/types`,
          ],
          excludedPaths: [],
          excludeFilters: [],
          folderId: rootPath,
          includedPaths: [`${rootPath}/e2e/types/performance.ts`],
          includeFilters: [],
          kind: 'recursive-folder',
          manifestFingerprint: 'fp-desktop-e2e',
          manifestSnapshotId: 'snapshot-desktop-e2e',
          rootPath: `${rootPath}/e2e/page-objects`,
          totalSelectedCount: 2,
          useRegex: false,
        },
        {
          directoryCounts: new Map([
            [rootPath, 1],
            [`${rootPath}/e2e`, 1],
            [`${rootPath}/e2e/page-objects`, 1],
          ]),
          errorMessage: null,
          filePaths: [`${rootPath}/e2e/page-objects/file-explorer-page.ts`],
          fingerprint: 'fp-desktop-e2e',
          pathSet: new Set([`${rootPath}/e2e/page-objects/file-explorer-page.ts`]),
          snapshotId: 'snapshot-desktop-e2e',
          status: 'ready',
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
});
