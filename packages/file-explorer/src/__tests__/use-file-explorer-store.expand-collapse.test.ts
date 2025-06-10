import { createMemoryStorageAdapter } from '@brainstrike/storage';
import type { IFileNode } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types'; // Import defaults
import { beforeEach, describe, expect, test } from 'vitest';
import { createFileExplorerStore } from '../store';

// A simple file tree for testing
const sampleFileTree: IFileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    children: [
      {
        name: 'components',
        path: 'src/components',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'Header.tsx',
            path: 'src/components/Header.tsx',
            type: 'file',
            handle: {} as FileSystemFileHandle,
            depth: 2,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
      {
        name: 'utils',
        path: 'src/utils',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      },
      {
        name: 'index.ts',
        path: 'src/index.ts',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
    ],
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file',
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
  },
];

describe('FileExplorerStore expand/collapse functionality', () => {
  let store: ReturnType<typeof createFileExplorerStore>;

  beforeEach(() => {
    store = createFileExplorerStore(createMemoryStorageAdapter());
    store.setState({
      ...DEFAULT_STATE,
      lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
    });
  });

  test('expandAllDirectories adds all directory paths from file tree', () => {
    // Ensure initial state is empty
    expect(store.getState().expandedDirectoryPaths.size).toBe(0);

    store.getState().expandAllDirectories(sampleFileTree);
    const expanded = store.getState().expandedDirectoryPaths;

    // Expect 'src', 'src/components', and 'src/utils' to be expanded, but not files
    expect(expanded.has('src')).toBe(true);
    expect(expanded.has('src/components')).toBe(true);
    expect(expanded.has('src/utils')).toBe(true);
    // Files should not be added
    expect(expanded.has('src/index.ts')).toBe(false);
    expect(expanded.has('package.json')).toBe(false);
  });

  test('collapseAllDirectories resets expanded directory paths', () => {
    store.getState().expandAllDirectories(sampleFileTree);
    expect(store.getState().expandedDirectoryPaths.size).toBeGreaterThan(0);

    // Collapse directories
    store.getState().collapseAllDirectories();
    expect(store.getState().expandedDirectoryPaths.size).toBe(0);
  });
});
