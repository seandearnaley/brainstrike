import { win32 } from 'node:path';
import { memoizedFileExplorer } from '@brainstrike/file-explorer/file-tree';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FlattenedNode } from '@brainstrike/file-tree-worker';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  applyDirectorySelectionMutation,
  applyFileSelectionMutation,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  buildRowsFromWorkerNodes,
  computeNodeSelectionState,
  type DirectorySelectionTraversalContext,
  getNormalizedImmediateChildren,
  getSelectedDescendantPathsForDirectory,
  hasNormalizedUnloadedDirectoryChildren,
  hasUnloadedDirectoryChildren,
  indexFileNodesByPath,
  resolveDirectorySelectionMutation,
  shouldLoadDirectoryRecursively,
} from '../tree/optimized-file-tree-model';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  hasNormalizedIncompleteDescendants,
  type NormalizedFileTreeState,
} from '../utils/normalized-file-tree';

const defaultRowsOptions = {
  expandedDirectoryPaths: new Set<string>(),
  folderId: 'root',
  loadingFiles: new Set<string>(),
};

const workspaceSelectionModel: FileExplorerState['selectionModel'] = createEmptySelectionModel();

function createFileNode(path: string, overrides: Partial<IFileNode> = {}): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(
  path: string,
  children: IFileNode[] = [],
  overrides: Partial<IFileNode> = {}
): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    children,
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
    ...overrides,
  };
}

function createTruncatedNode(path: string, overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'Showing first 10,000 entries',
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'truncated',
    ...overrides,
  };
}

function createFlattenedNode(path: string, depth: number): FlattenedNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth,
    node: {
      depth,
      name,
      path,
      rootFolderId: 'root',
      type: path.includes('.') ? 'file' : 'directory',
    },
  };
}

describe('optimized file tree model mutations', () => {
  it('resolves no-op, remove, capacity, and partial-add directory mutations', () => {
    expect(
      resolveDirectorySelectionMutation({
        allFilePaths: [],
        currentSelectionSize: 0,
        directoryTotalFiles: 0,
        folderId: 'root',
        maxSelectionCount: 10,
        selectedCount: 0,
        selectedFilePaths: new Set<string>(),
      })
    ).toEqual({ action: 'none', limitTruncated: false, paths: [] });

    expect(
      resolveDirectorySelectionMutation({
        allFilePaths: ['/src/a.ts', '/src/b.ts'],
        currentSelectionSize: 2,
        directoryTotalFiles: 2,
        folderId: 'root',
        maxSelectionCount: 10,
        selectedCount: 2,
        selectedFilePaths: new Set([
          encodeFileSelection('root', '/src/a.ts'),
          encodeFileSelection('root', '/src/b.ts'),
        ]),
      })
    ).toEqual({ action: 'remove', limitTruncated: false, paths: ['/src/a.ts', '/src/b.ts'] });

    // Zero slots left: blocked entirely BY THE LIMIT — callers must be able
    // to tell this apart from "nothing to select" to surface honest feedback.
    expect(
      resolveDirectorySelectionMutation({
        allFilePaths: ['/src/a.ts'],
        currentSelectionSize: 1,
        directoryTotalFiles: 1,
        folderId: 'root',
        maxSelectionCount: 1,
        selectedCount: 0,
        selectedFilePaths: new Set<string>(),
      })
    ).toEqual({ action: 'none', limitTruncated: true, paths: [] });

    expect(
      resolveDirectorySelectionMutation({
        allFilePaths: ['/src/a.ts', '/src/b.ts', '/src/c.ts'],
        currentSelectionSize: 1,
        directoryTotalFiles: 3,
        folderId: 'root',
        maxSelectionCount: 3,
        selectedCount: 1,
        selectedFilePaths: new Set([encodeFileSelection('root', '/src/a.ts')]),
      })
    ).toEqual({ action: 'add', limitTruncated: false, paths: ['/src/b.ts', '/src/c.ts'] });

    // Partial fill: only one slot left for two unselected files (decision D3:
    // fill to the cap rather than reject, and report the truncation).
    expect(
      resolveDirectorySelectionMutation({
        allFilePaths: ['/src/a.ts', '/src/b.ts', '/src/c.ts'],
        currentSelectionSize: 1,
        directoryTotalFiles: 3,
        folderId: 'root',
        maxSelectionCount: 2,
        selectedCount: 1,
        selectedFilePaths: new Set([encodeFileSelection('root', '/src/a.ts')]),
      })
    ).toEqual({ action: 'add', limitTruncated: true, paths: ['/src/b.ts'] });
  });

  it('dispatches directory and file selection mutations without extra store calls', () => {
    const addMultipleSelectedFiles = vi.fn();
    const removeMultipleSelectedFiles = vi.fn();
    const toggleSelectedFile = vi.fn();

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'remove', limitTruncated: false, paths: ['/src/a.ts'] },
      removeMultipleSelectedFiles,
    });
    expect(removeMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/src/a.ts']);

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'add', limitTruncated: false, paths: ['/src/b.ts'] },
      removeMultipleSelectedFiles,
    });
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/src/b.ts']);

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'none', limitTruncated: false, paths: [] },
      removeMultipleSelectedFiles,
    });
    expect(addMultipleSelectedFiles).toHaveBeenCalledTimes(1);
    expect(removeMultipleSelectedFiles).toHaveBeenCalledTimes(1);

    applyFileSelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      nodePath: '/src/c.ts',
      removeMultipleSelectedFiles,
      selectionMode: 'query',
      selectionState: { checkboxState: false, wouldExceedLimit: false },
      toggleSelectedFile,
    });
    expect(toggleSelectedFile).toHaveBeenCalledWith('root', '/src/c.ts');

    applyFileSelectionMutation({
      addMultipleSelectedFiles,
      folderId: '/workspace',
      nodePath: '/workspace/src/d.ts',
      removeMultipleSelectedFiles,
      selectionMode: 'explicit',
      selectionState: { checkboxState: true, wouldExceedLimit: false },
      toggleSelectedFile,
    });
    expect(removeMultipleSelectedFiles).toHaveBeenLastCalledWith('/workspace', [
      '/workspace/src/d.ts',
      '/src/d.ts',
      'src/d.ts',
    ]);

    applyFileSelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      nodePath: '/src/e.ts',
      removeMultipleSelectedFiles,
      selectionMode: 'explicit',
      selectionState: { checkboxState: false, wouldExceedLimit: false },
      toggleSelectedFile,
    });
    expect(addMultipleSelectedFiles).toHaveBeenLastCalledWith('root', ['/src/e.ts']);
  });
});

describe('optimized file tree model selected descendant resolution', () => {
  it('filters workspace selections to matching folders and absolute-path candidates', () => {
    const selectedFilePaths = new Set([
      encodeFileSelection('/workspace', '/workspace/src/index.ts'),
      encodeFileSelection('/workspace', 'src/relative.ts'),
      encodeFileSelection('/workspace', '/workspace/docs/readme.md'),
      encodeFileSelection('other-root', '/workspace/src/ignored.ts'),
    ]);

    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: '/workspace/src',
        folderId: '/workspace',
        querySelectionManifest: null,
        selectedFilePaths,
        selectionModel: workspaceSelectionModel,
      }).sort()
    ).toEqual(['/workspace/src/index.ts', 'src/relative.ts']);
  });

  it('uses ready query manifests and restored materialized paths for query selections', () => {
    const queryDescriptor: NonNullable<FileExplorerState['selectionModel']['queryDescriptor']> = {
      coveredDirectoryPaths: ['/src'],
      excludedPaths: [],
      excludeFilters: [],
      folderId: 'root',
      includedPaths: [],
      includeFilters: [],
      kind: 'recursive-folder',
      manifestFingerprint: 'fp-src',
      manifestSnapshotId: 'snap-src',
      rootPath: '/src',
      totalSelectedCount: 2,
      useRegex: false,
    };
    const selectionModel: FileExplorerState['selectionModel'] = {
      ...createEmptySelectionModel(),
      materializedPaths: new Set(['/src/restored.ts', '/docs/restored.md']),
      mode: 'query',
      queryDescriptor,
    };

    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: '/src',
        folderId: 'root',
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/a.ts', '/docs/readme.md'],
          fingerprint: 'fp-src',
          pathSet: new Set(['/src/a.ts', '/docs/readme.md']),
          snapshotId: 'snap-src',
          status: 'ready',
        },
        selectedFilePaths: new Set<string>(),
        selectionModel,
      })
    ).toEqual(['/src/a.ts']);

    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: '/src',
        folderId: 'root',
        querySelectionManifest: null,
        selectedFilePaths: new Set<string>(),
        selectionModel,
      })
    ).toEqual(['/src/restored.ts']);
  });

  it('resolves the descendants of a checked Windows folder so clicking it deselects them', () => {
    // A desktop tree on Windows is keyed by native paths: `C:\mock\root\hooks`.
    const rootPath = win32.resolve('C:\\mock', 'root');
    const hooksPath = win32.join(rootPath, 'hooks');
    const hooksFiles = [
      win32.join(hooksPath, 'package.json'),
      win32.join(hooksPath, 'src', 'index.ts'),
    ];
    const siblingPath = win32.join(rootPath, 'hooks-extra', 'a.ts');
    const rootId = 'root-id';

    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: hooksPath,
        folderId: rootId,
        querySelectionManifest: null,
        selectedFilePaths: new Set(
          [...hooksFiles, siblingPath].map((filePath) => encodeFileSelection(rootId, filePath))
        ),
        selectionModel: workspaceSelectionModel,
      }).sort()
    ).toEqual(hooksFiles);

    const manifestPaths = [...hooksFiles, siblingPath];
    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: hooksPath,
        folderId: rootId,
        querySelectionManifest: {
          directoryCounts: new Map([[hooksPath, 2]]),
          errorMessage: null,
          filePaths: manifestPaths,
          fingerprint: 'fp-win',
          pathSet: new Set(manifestPaths),
          snapshotId: 'snap-win',
          status: 'ready',
        },
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          ...createEmptySelectionModel(),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: [rootPath],
            excludedPaths: [],
            excludeFilters: [],
            folderId: rootId,
            includedPaths: [],
            includeFilters: [],
            kind: 'recursive-folder',
            manifestFingerprint: 'fp-win',
            manifestSnapshotId: 'snap-win',
            rootPath,
            totalSelectedCount: manifestPaths.length,
            useRegex: false,
          },
        },
      }).sort()
    ).toEqual(hooksFiles);
  });
});

describe('optimized file tree model row builders', () => {
  it('builds main-thread rows from visible expanded nodes and loading state', () => {
    const tree = [
      createDirectoryNode('/src', [
        createFileNode('/src/index.ts', { depth: 1 }),
        createFileNode('/src/hidden.ts', { depth: 1, isVisible: false }),
      ]),
      createFileNode('/root.ts'),
    ];

    const srcNode = tree[0];
    if (!srcNode) {
      throw new Error('Expected source directory fixture');
    }

    expect(shouldLoadDirectoryRecursively(srcNode)).toBe(false);

    const rows = buildFileTreeRows(tree, {
      ...defaultRowsOptions,
      expandedDirectoryPaths: new Set(['/src']),
      isLoadingForSelection: true,
      loadingFiles: new Set([encodeFileSelection('root', '/root.ts')]),
      loadingPathForSelection: '/src',
    });

    expect(rows.map((row) => row.id)).toEqual(['/src', '/src/index.ts', '/root.ts']);
    expect(rows[0]?.data.isLoadingForSelection).toBe(true);
    expect(rows[2]?.data.isFileLoading).toBe(true);
  });

  it('indexes nested nodes and builds worker rows from visible lookups only', () => {
    const tree = [
      createDirectoryNode('/src', [
        createFileNode('/src/index.ts', { depth: 1 }),
        createFileNode('/src/hidden.ts', { depth: 1, isVisible: false }),
      ]),
    ];
    const lookup = new Map<string, IFileNode>();
    indexFileNodesByPath(tree, lookup);

    const flattenedNodes = [
      createFlattenedNode('/missing', 0),
      createFlattenedNode('/src', 0),
      createFlattenedNode('/src/hidden.ts', 1),
      createFlattenedNode('/src/index.ts', 1),
    ];

    const rows = buildRowsFromWorkerNodes(
      flattenedNodes,
      (path) => lookup.get(path),
      defaultRowsOptions,
      (path) => (path === '/src' ? 8 : 0)
    );

    expect(Array.from(lookup.keys())).toEqual(['/src', '/src/index.ts', '/src/hidden.ts']);
    expect(rows.map((row) => [row.id, row.parentId, row.data.directoryTotalFiles])).toEqual([
      ['/src', null, 8],
      ['/src/index.ts', '/src', 0],
    ]);
  });

  it('builds normalized rows with allowed-path filtering and stale child references ignored', () => {
    const normalizedTree = createNormalizedFileTreeState([
      createDirectoryNode('/src', [
        createDirectoryNode('/src/lazy', [], { depth: 1, loadState: 'unloaded' }),
        createFileNode('/src/index.ts', { depth: 1 }),
        createFileNode('/src/filtered.ts', { depth: 1 }),
      ]),
      createFileNode('/hidden-root.ts', { isVisible: false }),
    ]);
    normalizedTree.childPathsByPath.get('/src')?.push('/src/missing.ts');
    normalizedTree.rootPaths.push('/missing-root.ts');
    const allowedPaths = new Set(['/src', '/src/lazy', '/src/index.ts', '/hidden-root.ts']);

    expect(
      getNormalizedImmediateChildren(normalizedTree, '/src', allowedPaths).map((node) => node.path)
    ).toEqual(['/src/lazy', '/src/index.ts']);
    expect(hasNormalizedUnloadedDirectoryChildren(normalizedTree, '/src', allowedPaths)).toBe(true);

    const rows = buildRowsFromNormalizedTree(
      normalizedTree,
      { ...defaultRowsOptions, expandedDirectoryPaths: new Set(['/src']) },
      (path) => (path === '/src' ? 2 : 0),
      allowedPaths
    );

    expect(
      rows.map((row) => [row.id, row.parentId, row.data.hasUnloadedDirectoryChildren])
    ).toEqual([
      ['/src', null, true],
      ['/src/lazy', '/src', false],
      ['/src/index.ts', '/src', false],
    ]);
  });

  it('a truncated marker row sorts last within its directory and is not expandable', () => {
    const rows = buildFileTreeRows(
      [
        createFileNode('/r/zzz.md'),
        createTruncatedNode('/r/…truncated…'),
        createDirectoryNode('/r/aaa'),
      ],
      {
        ...defaultRowsOptions,
        sort: {
          getMetadata: () => ({ size: 'excluded', tokens: 'excluded', type: '' }),
          state: { direction: 'asc', field: 'name' },
        },
      }
    );

    expect(rows.map((row) => row.id)).toEqual(['/r/aaa', '/r/zzz.md', '/r/…truncated…']);
    expect(rows.at(-1)?.type).toBe('truncated');
    expect(rows.at(-1)?.hasChildren).toBe(false);
  });

  it('a truncated marker inside a nested expanded directory sorts last among its own siblings, not the whole tree', () => {
    const rows = buildFileTreeRows(
      [
        createDirectoryNode('/r/aaa', [
          createTruncatedNode('/r/aaa/…truncated…'),
          createFileNode('/r/aaa/nested-file.md'),
          createDirectoryNode('/r/aaa/nested-dir'),
        ]),
        createFileNode('/r/zzz.md'),
      ],
      {
        ...defaultRowsOptions,
        expandedDirectoryPaths: new Set(['/r/aaa']),
        sort: {
          getMetadata: () => ({ size: 'excluded', tokens: 'excluded', type: '' }),
          state: { direction: 'asc', field: 'name' },
        },
      }
    );

    // The marker sorts last within `/r/aaa`'s own children (after the real
    // directory and file, both alphabetically ordered) — but a root-level
    // sibling declared AFTER `/r/aaa` in the input still follows it in the
    // flattened DFS order, proving "last within its directory" is scoped to
    // the parent bucket, not a whole-tree tail pin.
    expect(rows.map((row) => row.id)).toEqual([
      '/r/aaa',
      '/r/aaa/nested-dir',
      '/r/aaa/nested-file.md',
      '/r/aaa/…truncated…',
      '/r/zzz.md',
    ]);
    const markerRow = rows.find((row) => row.type === 'truncated');
    expect(markerRow?.parentId).toBe('/r/aaa');
  });
});

describe('directory tri-state derivation with unloaded descendants', () => {
  const maxSelectionCount = 1000;

  function createFallbackTraversalContext(): DirectorySelectionTraversalContext {
    return {
      getDirectoryMetadata: (node: IFileNode) => {
        if (node.type !== 'directory') {
          return {
            directoryTotalFiles: 0,
            hasIncompleteDescendants: false,
            hasUnloadedDirectoryChildren: false,
            immediateChildren: [],
          };
        }
        const folderFileCount = memoizedFileExplorer.getFolderFileCount(node);
        return {
          directoryTotalFiles: folderFileCount.count,
          hasIncompleteDescendants: !folderFileCount.isComplete,
          hasUnloadedDirectoryChildren: hasUnloadedDirectoryChildren(node),
          immediateChildren: node.children ?? [],
        };
      },
    };
  }

  function createNormalizedTraversalContext(
    normalizedTree: NormalizedFileTreeState
  ): DirectorySelectionTraversalContext {
    return {
      getDirectoryMetadata: (node: IFileNode) =>
        node.type === 'directory'
          ? {
              directoryTotalFiles: getNormalizedDescendantFileCount(normalizedTree, node.path),
              hasIncompleteDescendants: hasNormalizedIncompleteDescendants(
                normalizedTree,
                node.path
              ),
              hasUnloadedDirectoryChildren: hasNormalizedUnloadedDirectoryChildren(
                normalizedTree,
                node.path,
                null
              ),
              immediateChildren: getNormalizedImmediateChildren(normalizedTree, node.path, null),
            }
          : {
              directoryTotalFiles: 0,
              hasIncompleteDescendants: false,
              hasUnloadedDirectoryChildren: false,
              immediateChildren: [],
            },
    };
  }

  function computeStateForRow(
    rows: ReturnType<typeof buildFileTreeRows>,
    rowId: string,
    traversalContext: DirectorySelectionTraversalContext,
    selectedFilePaths: Set<string>,
    selectedDirectoryCounts: Map<string, number>
  ) {
    const row = rows.find((candidate) => candidate.id === rowId);
    if (!row) {
      throw new Error(`row not found: ${rowId}`);
    }
    return computeNodeSelectionState(
      row.data,
      traversalContext,
      'root',
      null,
      workspaceSelectionModel,
      selectedFilePaths,
      selectedDirectoryCounts,
      selectedFilePaths.size,
      maxSelectionCount
    );
  }

  it('renders a folder indeterminate, not checked, when its only loaded file is selected but an unloaded subdirectory remains', () => {
    const src = createDirectoryNode('/src', [
      createFileNode('/src/a.ts', { depth: 1 }),
      createDirectoryNode('/src/lazy', [], { depth: 1, loadState: 'unloaded' }),
    ]);
    const rows = buildFileTreeRows([src], defaultRowsOptions);
    const selectedFilePaths = new Set([encodeFileSelection('root', '/src/a.ts')]);
    const selectedDirectoryCounts = new Map([['/src', 1]]);

    const state = computeStateForRow(
      rows,
      '/src',
      createFallbackTraversalContext(),
      selectedFilePaths,
      selectedDirectoryCounts
    );

    expect(state.checkboxState).toBe('indeterminate');
  });

  it('renders ancestors indeterminate when the unloaded directory is nested below a loaded child', () => {
    const src = createDirectoryNode('/src', [
      createDirectoryNode(
        '/src/sub',
        [
          createFileNode('/src/sub/b.ts', { depth: 2 }),
          createDirectoryNode('/src/sub/lazy', [], { depth: 2, loadState: 'unloaded' }),
        ],
        { depth: 1 }
      ),
    ]);
    const rows = buildFileTreeRows([src], {
      ...defaultRowsOptions,
      expandedDirectoryPaths: new Set(['/src']),
    });
    const selectedFilePaths = new Set([encodeFileSelection('root', '/src/sub/b.ts')]);
    const selectedDirectoryCounts = new Map([
      ['/src', 1],
      ['/src/sub', 1],
    ]);
    const traversalContext = createFallbackTraversalContext();

    expect(
      computeStateForRow(rows, '/src', traversalContext, selectedFilePaths, selectedDirectoryCounts)
        .checkboxState
    ).toBe('indeterminate');
    expect(
      computeStateForRow(
        rows,
        '/src/sub',
        traversalContext,
        selectedFilePaths,
        selectedDirectoryCounts
      ).checkboxState
    ).toBe('indeterminate');
  });

  it('still renders a fully loaded, fully selected folder checked', () => {
    const src = createDirectoryNode('/src', [
      createFileNode('/src/a.ts', { depth: 1 }),
      createDirectoryNode('/src/sub', [createFileNode('/src/sub/b.ts', { depth: 2 })], {
        depth: 1,
      }),
    ]);
    const rows = buildFileTreeRows([src], defaultRowsOptions);
    const selectedFilePaths = new Set([
      encodeFileSelection('root', '/src/a.ts'),
      encodeFileSelection('root', '/src/sub/b.ts'),
    ]);
    const selectedDirectoryCounts = new Map([
      ['/src', 2],
      ['/src/sub', 1],
    ]);

    const state = computeStateForRow(
      rows,
      '/src',
      createFallbackTraversalContext(),
      selectedFilePaths,
      selectedDirectoryCounts
    );

    expect(state.checkboxState).toBe(true);
  });

  it('renders a query-mode folder CHECKED, not indeterminate, when its only real child is selected alongside a truncated marker', () => {
    const src = createDirectoryNode('/src', [
      createFileNode('/src/a.ts', { depth: 1 }),
      createTruncatedNode('/src/…truncated…', { depth: 1 }),
    ]);
    const rows = buildFileTreeRows([src], defaultRowsOptions);
    const selectedFilePaths = new Set([encodeFileSelection('root', '/src/a.ts')]);
    const selectedDirectoryCounts = new Map([['/src', 1]]);

    const queryDescriptor: NonNullable<FileExplorerState['selectionModel']['queryDescriptor']> = {
      coveredDirectoryPaths: ['/src'],
      excludedPaths: [],
      excludeFilters: [],
      folderId: 'root',
      includedPaths: [],
      includeFilters: [],
      kind: 'recursive-folder',
      manifestFingerprint: 'fp-src',
      manifestSnapshotId: 'snap-src',
      rootPath: '/src',
      totalSelectedCount: 1,
      useRegex: false,
    };
    const selectionModel: FileExplorerState['selectionModel'] = {
      ...createEmptySelectionModel(),
      materializedPaths: new Set(['/src/a.ts']),
      mode: 'query',
      queryDescriptor,
    };

    const row = rows.find((candidate) => candidate.id === '/src');
    if (!row) {
      throw new Error('row not found: /src');
    }

    const state = computeNodeSelectionState(
      row.data,
      createFallbackTraversalContext(),
      'root',
      null,
      selectionModel,
      selectedFilePaths,
      selectedDirectoryCounts,
      selectedFilePaths.size,
      maxSelectionCount
    );

    expect(state.checkboxState).toBe(true);
  });

  it('renders a normalized-tree folder indeterminate when an unloaded subdirectory remains', () => {
    const src = createDirectoryNode('/src', [
      createFileNode('/src/a.ts', { depth: 1 }),
      createDirectoryNode('/src/lazy', [], { depth: 1, loadState: 'unloaded' }),
    ]);
    const normalizedTree = createNormalizedFileTreeState([src]);
    const rows = buildRowsFromNormalizedTree(
      normalizedTree,
      defaultRowsOptions,
      (path) => getNormalizedDescendantFileCount(normalizedTree, path),
      null
    );
    const selectedFilePaths = new Set([encodeFileSelection('root', '/src/a.ts')]);
    const selectedDirectoryCounts = new Map([['/src', 1]]);

    const state = computeStateForRow(
      rows,
      '/src',
      createNormalizedTraversalContext(normalizedTree),
      selectedFilePaths,
      selectedDirectoryCounts
    );

    expect(state.checkboxState).toBe('indeterminate');
  });
});
