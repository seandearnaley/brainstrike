import type { IFileNode } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types'; // Import defaults
import { beforeEach, describe, expect, test } from 'vitest'; // Added imports
import { useFileExplorerStore } from '../store';

// A simple file tree for testing
const sampleFileTree: IFileNode[] = [
  {
    children: [
      {
        children: [
          {
            depth: 2,
            handle: {} as FileSystemFileHandle,
            name: 'Header.tsx',
            path: 'src/components/Header.tsx',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 1,
        handle: {} as FileSystemDirectoryHandle,
        name: 'components',
        path: 'src/components',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
      {
        children: [],
        depth: 1,
        handle: {} as FileSystemDirectoryHandle,
        name: 'utils',
        path: 'src/utils',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      },
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'index.ts',
        path: 'src/index.ts',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
    ],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    name: 'src',
    path: 'src',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  },
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    name: 'package.json',
    path: 'package.json',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  },
];

describe('FileExplorerStore expand/collapse functionality', () => {
  // Reset the store state before each test
  beforeEach(() => {
    // Reset store state before each test
    useFileExplorerStore.setState({
      ...DEFAULT_STATE, // Use imported defaults
      currentFolderId: null,
      expandedDirectoryPaths: new Set<string>(),
      folderStates: {}, // Reset folder states
      // Ensure lastActiveTab has a default
      lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
      selectedFilePaths: new Set<string>(),
    }); // Simply set the desired state properties, don't replace
  });

  test('expandAllDirectories adds all directory paths from file tree', () => {
    // Ensure initial state is empty
    expect(useFileExplorerStore.getState().expandedDirectoryPaths.size).toBe(0);

    useFileExplorerStore.getState().expandAllDirectories(sampleFileTree);
    const expanded = useFileExplorerStore.getState().expandedDirectoryPaths;

    // Expect 'src', 'src/components', and 'src/utils' to be expanded, but not files
    expect(expanded.has('src')).toBe(true);
    expect(expanded.has('src/components')).toBe(true);
    expect(expanded.has('src/utils')).toBe(true);
    // Files should not be added
    expect(expanded.has('src/index.ts')).toBe(false);
    expect(expanded.has('package.json')).toBe(false);
  });

  test('collapseAllDirectories resets expanded directory paths', () => {
    useFileExplorerStore.getState().expandAllDirectories(sampleFileTree);
    expect(useFileExplorerStore.getState().expandedDirectoryPaths.size).toBeGreaterThan(0);

    // Collapse directories
    useFileExplorerStore.getState().collapseAllDirectories();
    expect(useFileExplorerStore.getState().expandedDirectoryPaths.size).toBe(0);
  });
});
