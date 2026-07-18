import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryExpansionActions } from '../directory-expansion-actions';

// Helper to create a full mock state with required properties and stubbed actions
const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
  activeRootIds: [],
  addActiveRoot: vi.fn(),
  addMultipleSelectedFiles: vi.fn(),
  addMultipleSelectedFilesChunked: vi.fn(),
  addSelectedFile: vi.fn(),
  clearAllFileContents: vi.fn(),
  clearDisabledFilters: vi.fn(),
  clearFileContents: vi.fn(),
  clearQuickFilter: vi.fn(),
  clearSelectedFiles: vi.fn(),
  clearSelectionRules: vi.fn(),
  collapseAllDirectories: vi.fn(),
  commitRulesToExplicit: vi.fn(),
  currentFolderId: null,
  devInlineFixtureEnabled: false,
  disabledExcludeFilters: new Set<string>(),
  disabledIncludeFilters: new Set<string>(),
  evictOldFileContents: vi.fn(),
  excludeFilters: [],
  expandAllDirectories: vi.fn(),
  expandedDirectoryPaths: new Set<string>(),
  fileContents: {},
  folderAccessOrder: [],
  folderStates: {},
  folderSummaryThreshold: 100,
  getFileContent: vi.fn(),
  getFileContentCacheStats: vi.fn(),
  hydrateFolderState: vi.fn(),
  includeFilters: [],
  includeProjectTree: true,
  isAccessLoading: false,
  isFilterChipsVisible: true,
  isFiltersExpanded: true,
  lastActiveTab: 'files',
  maxSelectionCount: 100,
  querySelectionManifest: null,
  quickFilter: '',
  removeActiveRoot: vi.fn(),
  removeMultipleSelectedFiles: vi.fn(),
  removeSelectedFile: vi.fn(),
  rootDescriptors: {},
  selectedFilePaths: new Set<string>(),
  selectionModel: createEmptySelectionModel(),
  selectionVersion: 0,
  setActiveRoots: vi.fn(),
  setCurrentFolderId: vi.fn(),
  setDevInlineFixtureEnabled: vi.fn(),
  setExpandedPaths: vi.fn(),
  setFileContent: vi.fn(),
  setFilterChipsVisible: vi.fn(),
  setFilters: vi.fn(),
  setFiltersExpanded: vi.fn(),
  setFolderSelection: vi.fn(),
  setFolderSummaryThreshold: vi.fn(),
  setIncludeProjectTree: vi.fn(),
  setIsAccessLoading: vi.fn(),
  setLastActiveTab: vi.fn(),
  setMainRoot: vi.fn(),
  setMaterializedPaths: vi.fn(),
  setMaxSelectionCount: vi.fn(),
  setQuerySelection: vi.fn(),
  setQuerySelectionManifest: vi.fn(),
  setQuickFilter: vi.fn(),
  setSelectedFiles: vi.fn(),
  setSelectionMode: vi.fn(),
  setSelectionRules: vi.fn(),
  setTokenBudget: vi.fn(),
  setUseRegex: vi.fn(),
  setViewFilterPresetId: vi.fn(),
  toggleDirectoryExpansion: vi.fn(),
  toggleFilterEnabled: vi.fn(),
  toggleSelectedFile: vi.fn(),
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  useRegex: false,
  viewFilterPresetId: null,
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
        children: [
          {
            depth: 1,
            handle: {} as FileSystemFileHandle,
            name: 'index.ts',
            path: 'src/index.ts',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
          {
            children: [],
            depth: 1,
            handle: {} as FileSystemDirectoryHandle,
            name: 'sub',
            path: 'src/sub',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
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
    const state = createMockState({ expandedDirectoryPaths: new Set(['some/path']) });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.collapseAllDirectories();

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    expect(updated.expandedDirectoryPaths?.size).toBe(0);
  });

  it('setExpandedPaths should update both global and folder state when folder exists', () => {
    const state = createMockState({
      currentFolderId: 'myFolder',
      folderStates: {
        myFolder: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files',
          maxSelectionCount: 100,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          tokenBudget: 100,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
    });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.setExpandedPaths(new Set(['a', 'b']));

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);

    // Global paths should be updated
    expect(updated.expandedDirectoryPaths?.has('a')).toBe(true);
    expect(updated.expandedDirectoryPaths?.has('b')).toBe(true);

    // Folder state should also be updated for persistence
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths?.has('a')).toBe(true);
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths?.has('b')).toBe(true);
  });

  it('setExpandedPaths adopts the caller-provided set without cloning', () => {
    // Every caller hands over a freshly built set (expand-all's updater,
    // restoration, collapse) — cloning it again here doubled the per-commit
    // Set allocation for large expansions (#1734 perf follow-up). Ownership
    // transfers to the store; callers must not mutate the set afterwards.
    const state = createMockState({
      currentFolderId: 'myFolder',
      folderStates: {
        myFolder: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files',
          maxSelectionCount: 100,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          tokenBudget: 100,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
    });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    const adoptedPaths = new Set(['a', 'b']);
    actions.setExpandedPaths(adoptedPaths);

    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);

    expect(updated.expandedDirectoryPaths).toBe(adoptedPaths);
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths).toBe(adoptedPaths);
  });

  it('toggleDirectoryExpansion should update both global and folder state when folder exists', () => {
    const state = createMockState({
      currentFolderId: 'myFolder',
      expandedDirectoryPaths: new Set(['existing']),
      folderStates: {
        myFolder: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(['existing']),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files',
          maxSelectionCount: 100,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          tokenBudget: 100,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
    });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    // Expand a new directory
    actions.toggleDirectoryExpansion('newPath');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);

    // Global paths should be updated
    expect(updated.expandedDirectoryPaths?.has('existing')).toBe(true);
    expect(updated.expandedDirectoryPaths?.has('newPath')).toBe(true);
    expect(updated.expandedDirectoryPaths?.size).toBe(2);

    // Folder state should also be updated for persistence
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths?.has('existing')).toBe(true);
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths?.has('newPath')).toBe(true);
    expect(updated.folderStates?.['myFolder']?.expandedDirectoryPaths?.size).toBe(2);
  });

  it('toggleDirectoryExpansion should NOT update folder state when folder does not exist', () => {
    const state = createMockState({
      currentFolderId: 'myFolder',
      expandedDirectoryPaths: new Set(['existing']),
      folderStates: {}, // Empty - no folder state exists
    });
    mockGet.mockReturnValue(state);
    const actions = createDirectoryExpansionActions(mockSet, mockGet);

    actions.toggleDirectoryExpansion('newPath');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);

    // Global paths should be updated
    expect(updated.expandedDirectoryPaths?.has('existing')).toBe(true);
    expect(updated.expandedDirectoryPaths?.has('newPath')).toBe(true);

    // Folder state should NOT be in the update (nothing to update)
    expect(updated.folderStates).toBeUndefined();
  });
});
