import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryExpansionActions } from '../directory-expansion-actions';

// Helper to create a full mock state with required properties and stubbed actions
const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
  currentFolderId: null,
  folderStates: {},
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 100,
  maxSelectionCount: 100,
  lastActiveTab: 'files',
  folderAccessOrder: [],
  setCurrentFolderId: vi.fn(),
  hydrateFolderState: vi.fn(),
  setSelectedFiles: vi.fn(),
  addSelectedFile: vi.fn(),
  removeSelectedFile: vi.fn(),
  toggleSelectedFile: vi.fn(),
  clearSelectedFiles: vi.fn(),
  setExpandedPaths: vi.fn(),
  toggleDirectoryExpansion: vi.fn(),
  setFilters: vi.fn(),
  setUseRegex: vi.fn(),
  setIncludeProjectTree: vi.fn(),
  setFolderSummaryThreshold: vi.fn(),
  setMaxSelectionCount: vi.fn(),
  setLastActiveTab: vi.fn(),
  expandAllDirectories: vi.fn(),
  collapseAllDirectories: vi.fn(),
  ...overrides,
});

describe('directory-expansion-actions', () => {
  const mockSet = vi.fn();
  const mockGet = vi.fn();

  beforeEach(() => {
    mockSet.mockClear();
    mockGet.mockReset();
  });

  it('should add path when toggling a collapsed directory', () => {
    const state = createMockState({ expandedDirectoryPaths: new Set(['a']) });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.toggleDirectoryExpansion('b');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    expect(updated.expandedDirectoryPaths?.has('a')).toBe(true);
    expect(updated.expandedDirectoryPaths?.has('b')).toBe(true);
    expect(updated.expandedDirectoryPaths?.size).toBe(2);
  });

  it('should remove path and its children when toggling an expanded directory', () => {
    const initial = new Set(['parent', 'parent/child', 'sibling']);
    const state = createMockState({ expandedDirectoryPaths: initial });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.toggleDirectoryExpansion('parent');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    expect(updated.expandedDirectoryPaths?.has('parent')).toBe(false);
    expect(updated.expandedDirectoryPaths?.has('parent/child')).toBe(false);
    expect(updated.expandedDirectoryPaths?.has('sibling')).toBe(true);
    expect(updated.expandedDirectoryPaths?.size).toBe(1);
  });

  it('expandAllDirectories should add all directory paths', () => {
    const fileTree: IFileNode[] = [
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
            name: 'index.ts',
            path: 'src/index.ts',
            type: 'file',
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'sub',
            path: 'src/sub',
            type: 'directory',
            handle: {} as FileSystemDirectoryHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
            children: [],
          },
        ],
      },
    ];
    const state = createMockState({ expandedDirectoryPaths: new Set(['existing']) });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.expandAllDirectories(fileTree);

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    const paths = updated.expandedDirectoryPaths;
    expect(paths?.has('existing')).toBe(true);
    expect(paths?.has('src')).toBe(true);
    expect(paths?.has('src/sub')).toBe(true);
    expect(paths?.has('src/index.ts')).toBe(false);
  });

  it('collapseAllDirectories should clear expanded paths', () => {
    const actions = createDirectoryExpansionActions(mockSet, mockGet);
    actions.collapseAllDirectories();

    expect(mockSet).toHaveBeenCalledWith({ expandedDirectoryPaths: new Set() });
  });
});
