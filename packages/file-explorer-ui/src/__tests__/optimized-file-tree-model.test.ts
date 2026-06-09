import type { FlattenedNode } from '@brainstrike/file-tree-worker';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  applyDirectorySelectionMutation,
  applyFileSelectionMutation,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  buildRowsFromWorkerNodes,
  getNormalizedImmediateChildren,
  getSelectedDescendantPathsForDirectory,
  hasNormalizedUnloadedDirectoryChildren,
  indexFileNodesByPath,
  resolveDirectorySelectionMutation,
  shouldLoadDirectoryRecursively,
} from '../tree/optimized-file-tree-model';
import { createNormalizedFileTreeState } from '../utils/normalized-file-tree';

const defaultRowsOptions = {
  expandedDirectoryPaths: new Set<string>(),
  folderId: 'root',
  loadingFiles: new Set<string>(),
};

const workspaceSelectionModel: FileExplorerState['selectionModel'] = createEmptySelectionModel();

function createFileNode(path: string, overrides: Partial<IFileNode> = {}): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    name,
    path,
    type: 'file',
    isVisible: true,
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
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
    name,
    path,
    type: 'directory',
    isVisible: true,
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    loadState: 'loaded',
    children,
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
    ).toEqual({ action: 'none', paths: [] });

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
    ).toEqual({ action: 'remove', paths: ['/src/a.ts', '/src/b.ts'] });

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
    ).toEqual({ action: 'none', paths: [] });

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
    ).toEqual({ action: 'add', paths: ['/src/b.ts', '/src/c.ts'] });
  });

  it('dispatches directory and file selection mutations without extra store calls', () => {
    const addMultipleSelectedFiles = vi.fn();
    const removeMultipleSelectedFiles = vi.fn();
    const toggleSelectedFile = vi.fn();

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'remove', paths: ['/src/a.ts'] },
      removeMultipleSelectedFiles,
    });
    expect(removeMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/src/a.ts']);

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'add', paths: ['/src/b.ts'] },
      removeMultipleSelectedFiles,
    });
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/src/b.ts']);

    applyDirectorySelectionMutation({
      addMultipleSelectedFiles,
      folderId: 'root',
      mutation: { action: 'none', paths: [] },
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
      kind: 'recursive-folder',
      folderId: 'root',
      rootPath: '/src',
      coveredDirectoryPaths: ['/src'],
      includeFilters: [],
      excludeFilters: [],
      includedPaths: [],
      excludedPaths: [],
      manifestFingerprint: 'fp-src',
      manifestSnapshotId: 'snap-src',
      totalSelectedCount: 2,
      useRegex: false,
    };
    const selectionModel: FileExplorerState['selectionModel'] = {
      ...createEmptySelectionModel(),
      mode: 'query',
      queryDescriptor,
      materializedPaths: new Set(['/src/restored.ts', '/docs/restored.md']),
    };

    expect(
      getSelectedDescendantPathsForDirectory({
        directoryPath: '/src',
        folderId: 'root',
        querySelectionManifest: {
          filePaths: ['/src/a.ts', '/docs/readme.md'],
          pathSet: new Set(['/src/a.ts', '/docs/readme.md']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-src',
          snapshotId: 'snap-src',
          status: 'ready',
          errorMessage: null,
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
});
