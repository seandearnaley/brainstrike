import type { FileExplorerState, FolderState } from '@brainstrike/types';
import { DEFAULT_STATE, MAX_FOLDER_STATES, MIN_MAX_SELECTION_COUNT } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createFolderStateActions } from '../actions/folder-state-actions';
import { createSettingsActions } from '../actions/settings-actions';

// Combine required action interfaces
type TestActions = ReturnType<typeof createFolderStateActions> &
  ReturnType<typeof createSettingsActions>;

describe('Folder State Actions', () => {
  let store: {
    setState: (
      fn: (state: FileExplorerState) => Partial<FileExplorerState> | FileExplorerState
    ) => void;
    getState: () => FileExplorerState;
  } & TestActions;

  const getInitialState = (): Partial<FileExplorerState> => ({
    ...DEFAULT_STATE,
    currentFolderId: null,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    folderStates: {},
    lastActiveTab: 'files' as const,
  });

  beforeEach(() => {
    const zustandStore = createStore<FileExplorerState>(
      () =>
        ({
          ...getInitialState(),
          // These will be overwritten by the real actions, but TypeScript needs them
          setCurrentFolderId: vi.fn(),
          hydrateFolderState: vi.fn(),
          setMaxSelectionCount: vi.fn(),
          setLastActiveTab: vi.fn(),
          setFilters: vi.fn(),
          setUseRegex: vi.fn(),
          setIncludeProjectTree: vi.fn(),
          setFolderSummaryThreshold: vi.fn(),
          setSelectedFiles: vi.fn(),
          addSelectedFile: vi.fn(),
          removeSelectedFile: vi.fn(),
          toggleSelectedFile: vi.fn(),
          clearSelectedFiles: vi.fn(),
          setExpandedPaths: vi.fn(),
          toggleDirectoryExpansion: vi.fn(),
          expandAllDirectories: vi.fn(),
          collapseAllDirectories: vi.fn(),
        }) as FileExplorerState
    );

    const folderActions = createFolderStateActions(zustandStore.setState, zustandStore.getState);
    const settingsActions = createSettingsActions(zustandStore.setState, zustandStore.getState);

    zustandStore.setState((state) => ({
      ...state,
      ...folderActions,
      ...settingsActions,
    }));

    store = {
      setState: zustandStore.setState,
      getState: zustandStore.getState,
      ...folderActions,
      ...settingsActions,
    };
  });

  it('should set current folder ID and create a new folder state if none exists', () => {
    const testFolderId = 'testFolder123';
    store.setCurrentFolderId(testFolderId);

    const state = store.getState();
    expect(state.currentFolderId).toBe(testFolderId);
    const folderState = state.folderStates[testFolderId];
    expect(folderState).toBeDefined();
    if (folderState) {
      expect(folderState.lastAccessed).toBeGreaterThan(0);
    }
    expect(state.selectedFilePaths.size).toBe(0);
    expect(state.expandedDirectoryPaths.size).toBe(0);
  });

  it('should create default folder state when switching to a new id', () => {
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: new Set(['file1']),
      expandedDirectoryPaths: new Set(['dir1']),
    }));

    store.setCurrentFolderId('newId');

    const state = store.getState();
    expect(state.currentFolderId).toBe('newId');
    // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
    const newState = state.folderStates['newId'];
    expect(newState).toBeDefined();
    if (!newState) throw new Error('Expected folder state to be defined');
    expect(newState.selectedFilePaths.size).toBe(0);
    expect(newState.expandedDirectoryPaths.size).toBe(0);
    expect(newState.useRegex).toBe(false);
    expect(newState.includeProjectTree).toBe(true);
    expect(newState.folderSummaryThreshold).toBe(100);
    expect(newState.maxSelectionCount).toBe(100);
    expect(newState.lastActiveTab).toBe('files');
    expect(newState.lastAccessed).toBeGreaterThan(0);
    expect(state.selectedFilePaths.size).toBe(0);
    expect(state.expandedDirectoryPaths.size).toBe(0);
  });

  it('should hydrate state with stored folder state when folder id is provided', () => {
    const testFolderId = 'testFolder123';
    const customFilters = ['*.tsx'];
    const customExcludeFilters = ['node_modules'];
    const selectedPaths = new Set(['path1', 'path2']);
    const expandedPaths = new Set(['dir1']);

    const initialFolderState: FolderState = {
      selectedFilePaths: selectedPaths,
      expandedDirectoryPaths: expandedPaths,
      includeFilters: customFilters,
      excludeFilters: customExcludeFilters,
      useRegex: true,
      includeProjectTree: false,
      folderSummaryThreshold: 10,
      maxSelectionCount: 50,
      lastActiveTab: 'settings',
      lastAccessed: Date.now(),
    };

    store.setState((state: FileExplorerState) => ({
      ...state,
      folderStates: {
        [testFolderId]: initialFolderState,
      },
    }));

    store.hydrateFolderState(testFolderId);

    const state = store.getState();
    expect(state.selectedFilePaths).toEqual(selectedPaths);
    expect(state.expandedDirectoryPaths).toEqual(expandedPaths);
    expect(state.includeFilters).toEqual(customFilters);
    expect(state.excludeFilters).toEqual(customExcludeFilters);
    expect(state.useRegex).toBe(true);
    expect(state.includeProjectTree).toBe(false);
    expect(state.folderSummaryThreshold).toBe(10);
    expect(state.maxSelectionCount).toBe(50);
    expect(state.lastActiveTab).toBe('settings');
  });

  it('should not change state if hydrating with a non-existent folder id', () => {
    const initialSelectedPaths = new Set(['initial']);
    const initialExpandedPaths = new Set(['initialDir']);
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: initialSelectedPaths,
      expandedDirectoryPaths: initialExpandedPaths,
    }));

    const stateBeforeHydrate = store.getState();
    store.hydrateFolderState('nonExistentFolder');
    const stateAfterHydrate = store.getState();

    expect(stateAfterHydrate.selectedFilePaths).toEqual(initialSelectedPaths);
    expect(stateAfterHydrate.expandedDirectoryPaths).toEqual(initialExpandedPaths);
    expect(stateAfterHydrate.includeFilters).toEqual(stateBeforeHydrate.includeFilters);
    expect(stateAfterHydrate.maxSelectionCount).toEqual(stateBeforeHydrate.maxSelectionCount);
  });

  it('should clean up oldest folder states when exceeding the maximum limit on setCurrentFolderId', () => {
    const now = Date.now();
    const folderStates: Record<string, FolderState> = {};
    const numFolders = MAX_FOLDER_STATES + 5;

    for (let i = 0; i < numFolders; i++) {
      const id = `folder${i}`;
      folderStates[id] = {
        lastAccessed: now - (numFolders - i) * 1000,
        selectedFilePaths: new Set([`${id}-file`]),
        expandedDirectoryPaths: new Set([`${id}-dir`]),
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 5,
        maxSelectionCount: 100,
        lastActiveTab: 'files',
      };
    }

    store.setState((state: FileExplorerState) => ({
      ...state,
      folderStates,
      folderAccessOrder: Object.keys(folderStates),
    }));

    expect(Object.keys(store.getState().folderStates).length).toBe(numFolders);

    const newFolderId = 'newFolder';
    store.setCurrentFolderId(newFolderId);

    const finalState = store.getState();
    const finalFolderKeys = Object.keys(finalState.folderStates);

    expect(finalFolderKeys.length).toBe(MAX_FOLDER_STATES);
    expect(finalState.folderAccessOrder.length).toBe(MAX_FOLDER_STATES);

    for (let i = 0; i < 5; i++) {
      expect(finalState.folderStates[`folder${i}`]).toBeUndefined();
    }

    // Verify the new folder state was created
    const newFolderState = finalState.folderStates[newFolderId];
    expect(newFolderState).toBeDefined();
    if (newFolderState) {
      expect(newFolderState.lastAccessed).toBeGreaterThan(0);
      expect(newFolderState.selectedFilePaths.size).toBe(0);
      expect(newFolderState.expandedDirectoryPaths.size).toBe(0);
    }
  });

  it('should reset current state fields when setting current folder ID to null', () => {
    // Arrange - set some state values and a current folder
    const folderToSave = 'someFolder';
    const selectedPaths = new Set(['file1', 'file2']);
    const expandedPaths = new Set(['dir1', 'dir2']);

    store.setState((state: FileExplorerState) => ({
      ...state,
      currentFolderId: folderToSave,
      selectedFilePaths: selectedPaths,
      expandedDirectoryPaths: expandedPaths,
      includeFilters: ['*.*'], // Give some non-default values to save
      useRegex: true,
    }));

    // Act - set current folder ID to null
    store.setCurrentFolderId(null);

    // Assert - Check that top-level fields are reset
    const state = store.getState();
    expect(state.currentFolderId).toBeNull();
    expect(state.selectedFilePaths.size).toBe(0);
    expect(state.expandedDirectoryPaths.size).toBe(0);

    // Assert - Check that the previous folder's state was saved
    const savedState = state.folderStates[folderToSave];
    expect(savedState).toBeDefined();
    if (!savedState) {
      throw new Error('Expected savedState to be defined');
    }
    expect(savedState.selectedFilePaths).toEqual(selectedPaths);
    expect(savedState.expandedDirectoryPaths).toEqual(expandedPaths);
    expect(savedState.includeFilters).toEqual(['*.*']);
    expect(savedState.useRegex).toBe(true);
  });

  // --- Tests for actions moved to settings-actions ---
  // Keep them here as they were part of the original file's scope

  it('[Settings Action] should set max selection count', () => {
    // Act
    store.setMaxSelectionCount(200);

    // Assert
    expect(store.getState().maxSelectionCount).toBe(200);
  });

  it('[Settings Action] should enforce minimum max selection count', () => {
    // Act - try to set selection count below minimum
    store.setMaxSelectionCount(MIN_MAX_SELECTION_COUNT - 1);

    // Assert - should be set to minimum
    expect(store.getState().maxSelectionCount).toBe(MIN_MAX_SELECTION_COUNT);

    // Act - try to set selection count at minimum
    store.setMaxSelectionCount(MIN_MAX_SELECTION_COUNT);
    expect(store.getState().maxSelectionCount).toBe(MIN_MAX_SELECTION_COUNT);
  });

  it('[Settings Action] should trim selected files when reducing max selection count', () => {
    // Arrange - select more files than new max
    const selectedFiles = new Set(['file1', 'file2', 'file3', 'file4', 'file5']);
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: selectedFiles,
      maxSelectionCount: 10, // Initial max count
    }));

    // Act - reduce max selection count using the action
    store.setMaxSelectionCount(3);

    // Assert
    const state = store.getState();
    expect(state.maxSelectionCount).toBe(3);
    expect(state.selectedFilePaths.size).toBe(3);
    // Should keep first 3 items based on Set iteration order (insertion order)
    expect(Array.from(state.selectedFilePaths)).toEqual(['file1', 'file2', 'file3']);
  });

  it('[Settings Action] should set last active tab', () => {
    // Act
    store.setLastActiveTab('settings');

    // Assert
    expect(store.getState().lastActiveTab).toBe('settings');
  });
});
