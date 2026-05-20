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
});
