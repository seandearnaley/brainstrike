import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import * as fileTreeWorker from '@brainstrike/file-tree-worker';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import type {
  DirectorySelectionTraversalContext,
  FileTreeRowData,
} from '../tree/optimized-file-tree-model';
import {
  createFileTreeSelectionStore,
  type FileTreeSelectionInputs,
} from '../tree/optimized-file-tree-selection-store';

const selectionModel: FileExplorerState['selectionModel'] = createEmptySelectionModel();

const traversalContext: DirectorySelectionTraversalContext = {
  getDirectoryMetadata: () => ({
    directoryTotalFiles: 0,
    hasIncompleteDescendants: false,
    hasUnloadedDirectoryChildren: false,
    immediateChildren: [],
  }),
};

function fileRow(path: string): FileTreeRowData {
  const fileNode: IFileNode = {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
  return {
    directoryTotalFiles: 0,
    fileNode,
    hasIncompleteDescendants: false,
    hasUnloadedDirectoryChildren: false,
    immediateChildren: [],
    isChildrenLoading: false,
    isFileLoading: false,
    isLoadingForSelection: false,
  };
}

function inputs(
  selected: Set<string>,
  overrides: Partial<FileTreeSelectionInputs> = {}
): FileTreeSelectionInputs {
  return {
    directoryTraversalContext: traversalContext,
    folderId: 'root',
    maxSelectionCount: 1000,
    querySelectionManifest: null,
    selectedCount: selected.size,
    selectedDirectoryCounts: new Map(),
    selectedFilePaths: selected,
    selectionModel,
    ...overrides,
  };
}

describe('createFileTreeSelectionStore', () => {
  it('prepares absolute path aliases once while reading current selection membership', () => {
    const folderId = '/workspace/project';
    const row = fileRow(`${folderId}/src/index.ts`);
    const relativeKey = encodeFileSelection(folderId, '/src/index.ts');
    const pathDerivations = vi.spyOn(fileTreeWorker, 'isDescendantPath');
    const store = createFileTreeSelectionStore(inputs(new Set(), { folderId }));

    expect(store.getNodeState(row).checkboxState).toBe(false);
    expect(pathDerivations).toHaveBeenCalledTimes(1);
    pathDerivations.mockClear();

    store.setInputs(inputs(new Set([relativeKey]), { folderId }));
    expect(store.getNodeState(row).checkboxState).toBe(true);
    expect(store.getNodeState(row).checkboxState).toBe(true);
    store.setInputs(inputs(new Set(), { folderId }));
    expect(store.getNodeState(row).checkboxState).toBe(false);
    expect(pathDerivations.mock.calls.length).toBe(0);
  });

  it('does not repeat alias preparation across 10,000 unchanged file nodes', () => {
    const folderId = '/workspace/large';
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      fileRow(`${folderId}/src/file-${index}.ts`)
    );
    const store = createFileTreeSelectionStore(inputs(new Set(), { folderId }));
    const pathDerivations = vi.spyOn(fileTreeWorker, 'isDescendantPath');
    for (const row of rows) {
      expect(store.getNodeState(row).checkboxState).toBe(false);
    }
    expect(pathDerivations).toHaveBeenCalledTimes(rows.length);
    pathDerivations.mockClear();

    store.setInputs(
      inputs(new Set([encodeFileSelection(folderId, 'src/file-9999.ts')]), { folderId })
    );
    let selectedCount = 0;
    for (const row of rows) {
      if (store.getNodeState(row).checkboxState) {
        selectedCount += 1;
      }
    }
    expect(selectedCount).toBe(1);
    expect(pathDerivations.mock.calls.length).toBe(0);
  });

  it.each([
    ['/workspace/project', '/workspace/project/src/index.ts', 'src/index.ts'],
    ['/workspace/project', '/workspace/project/src/index.ts', '/src/index.ts'],
    ['/workspace/project', '/workspace/project/src/index.ts', '/workspace/project/src/index.ts'],
    ['C:\\repo', 'C:\\repo\\src\\index.ts', 'src/index.ts'],
    ['C:\\repo', 'C:\\repo\\src\\index.ts', '/src/index.ts'],
    ['C:\\repo', 'C:\\repo\\src\\index.ts', 'C:\\repo\\src\\index.ts'],
  ])(
    'preserves cached membership for %s node %s selected as %s',
    (folderId, path, selectedPath) => {
      const row = fileRow(path);
      const store = createFileTreeSelectionStore(inputs(new Set(), { folderId }));
      expect(store.getNodeState(row).checkboxState).toBe(false);

      store.setInputs(inputs(new Set([encodeFileSelection(folderId, selectedPath)]), { folderId }));
      expect(store.getNodeState(row).checkboxState).toBe(true);
      expect(store.getNodeState(fileRow(path)).checkboxState).toBe(true);

      store.setInputs(inputs(new Set(), { folderId }));
      expect(store.getNodeState(row).checkboxState).toBe(false);
    }
  );

  it('invalidates prepared aliases when the same node changes folder or path', () => {
    const folderId = '/workspace/project';
    const row = fileRow(`${folderId}/src/index.ts`);
    const selected = new Set([encodeFileSelection(folderId, 'src/index.ts')]);
    const store = createFileTreeSelectionStore(inputs(selected, { folderId }));
    expect(store.getNodeState(row).checkboxState).toBe(true);

    store.setInputs(inputs(selected, { folderId: '/workspace/other' }));
    expect(store.getNodeState(row).checkboxState).toBe(false);

    store.setInputs(inputs(selected, { folderId }));
    expect(store.getNodeState(row).checkboxState).toBe(true);
    row.fileNode.path = `${folderId}/src/other.ts`;
    expect(store.getNodeState(row).checkboxState).toBe(false);
  });

  it('shares prepared file aliases with loaded-child tri-state traversal', () => {
    const folderId = '/workspace/project';
    const childRow = fileRow(`${folderId}/src/index.ts`);
    const siblingRow = fileRow(`${folderId}/src/other.ts`);
    const directoryRow: FileTreeRowData = {
      ...fileRow(`${folderId}/src`),
      directoryTotalFiles: 2,
      immediateChildren: [childRow.fileNode, siblingRow.fileNode],
    };
    directoryRow.fileNode = {
      ...directoryRow.fileNode,
      children: directoryRow.immediateChildren,
      loadState: 'loaded',
      type: 'directory',
    };
    const store = createFileTreeSelectionStore(inputs(new Set(), { folderId }));
    expect(store.getNodeState(childRow).checkboxState).toBe(false);
    expect(store.getNodeState(siblingRow).checkboxState).toBe(false);
    expect(store.getNodeState(directoryRow).checkboxState).toBe(false);
    const pathDerivations = vi.spyOn(fileTreeWorker, 'isDescendantPath');

    store.setInputs(
      inputs(new Set([encodeFileSelection(folderId, '/src/index.ts')]), { folderId })
    );
    expect(store.getNodeState(directoryRow).checkboxState).toBe('indeterminate');
    expect(store.getNodeState(childRow).checkboxState).toBe(true);
    store.setInputs(
      inputs(
        new Set([
          encodeFileSelection(folderId, '/src/index.ts'),
          encodeFileSelection(folderId, '/src/other.ts'),
        ]),
        { folderId }
      )
    );
    expect(store.getNodeState(directoryRow).checkboxState).toBe(true);
    expect(pathDerivations.mock.calls.length).toBe(0);
  });

  it('returns the derived checkbox state for a node', () => {
    const store = createFileTreeSelectionStore(
      inputs(new Set([encodeFileSelection('root', '/a.ts')]))
    );
    expect(store.getNodeState(fileRow('/a.ts')).checkboxState).toBe(true);
    expect(store.getNodeState(fileRow('/b.ts')).checkboxState).toBe(false);
  });

  it('returns a STABLE reference while a node state is unchanged, a NEW one when it changes', () => {
    const store = createFileTreeSelectionStore(inputs(new Set()));
    const row = fileRow('/a.ts');

    const first = store.getNodeState(row);
    // Re-read with identical inputs → same object (lets useSyncExternalStore skip it).
    expect(store.getNodeState(row)).toBe(first);

    // A DIFFERENT node changing must not disturb /a.ts's cached identity.
    store.setInputs(inputs(new Set([encodeFileSelection('root', '/b.ts')])));
    expect(store.getNodeState(row)).toBe(first);

    // /a.ts itself becoming selected → a new object (forces the cell to re-render).
    store.setInputs(inputs(new Set([encodeFileSelection('root', '/a.ts')])));
    const afterSelect = store.getNodeState(row);
    expect(afterSelect).not.toBe(first);
    expect(afterSelect.checkboxState).toBe(true);
  });

  it('evicts the per-node cache when the folder changes (bounded growth)', () => {
    const store = createFileTreeSelectionStore(inputs(new Set()));
    const row = fileRow('/a.ts');
    const first = store.getNodeState(row);
    // Same folder, unchanged state → cached identity is reused.
    expect(store.getNodeState(row)).toBe(first);

    // A folder switch clears the cache, so the same path yields a fresh object
    // (its old entry can no longer accumulate across folders).
    store.setInputs(inputs(new Set(), { folderId: 'other-root' }));
    expect(store.getNodeState(row)).not.toBe(first);
  });

  it('notify fires every current subscriber and unsubscribe stops delivery', () => {
    const store = createFileTreeSelectionStore(inputs(new Set()));
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribe(a);
    store.subscribe(b);

    store.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    store.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('tolerates a listener that unsubscribes a sibling mid-notify', () => {
    const store = createFileTreeSelectionStore(inputs(new Set()));
    const b = vi.fn();
    const unsubB = store.subscribe(() => unsubB());
    store.subscribe(b);
    expect(() => store.notify()).not.toThrow();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
