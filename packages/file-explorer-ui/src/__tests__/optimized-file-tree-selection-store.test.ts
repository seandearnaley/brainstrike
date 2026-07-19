import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
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
