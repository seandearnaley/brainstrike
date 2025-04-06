import type { FileExplorerState, FolderState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createFolderStateActions } from '../actions/folder-state-actions'; // Updated import
import { createSettingsActions } from '../actions/settings-actions'; // Import needed settings actions
import { MAX_FOLDER_STATES, MIN_MAX_SELECTION_COUNT } from '../constants/file-explorer-constants';

// Combine required action interfaces
type TestActions = ReturnType<typeof createFolderStateActions> &
  ReturnType<typeof createSettingsActions>;

describe('Folder State Actions', () => {
  // Define the store type with strong typing
  let store: {
    setState: (
      fn: (state: FileExplorerState) => Partial<FileExplorerState> | FileExplorerState
    ) => void;
    getState: () => FileExplorerState;
  } & TestActions; // Use combined actions type

  const getInitialState = (): FileExplorerState => ({
    ...DEFAULT_STATE, // Start with defaults
    currentFolderId: null,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    folderStates: {},
    // Ensure actions are added by the setup
    setCurrentFolderId: vi.fn(),
    hydrateFolderState: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setLastActiveTab: vi.fn(),
    setFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    // Add other necessary action placeholders if needed by tests
    setSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    removeSelectedFile: vi.fn(),
    toggleSelectedFile: vi.fn(),
    clearSelectedFiles: vi.fn(),
    setExpandedPaths: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    expandAllDirectories: vi.fn(),
    collapseAllDirectories: vi.fn(),
  });

  beforeEach(() => {
    // Create a new store instance for each test
    const zustandStore = createStore<FileExplorerState>(getInitialState);

    // Initialize actions
    const folderActions = createFolderStateActions(zustandStore.setState, zustandStore.getState);
    const settingsActions = createSettingsActions(zustandStore.setState, zustandStore.getState); // Initialize settings actions

    // Manually add actions to the store's state for the test setup
    // This mimics how the real store combines them
    zustandStore.setState({
      ...folderActions,
      ...settingsActions,
    });

    // Create the combined store object for testing
    store = {
      setState: zustandStore.setState,
      getState: zustandStore.getState,
      ...folderActions,
      ...settingsActions,
    };
  });

  it('should set current folder ID and create a new folder state if none exists', () => {
    const testFolderId = 'testFolder123';

    // Act - set the current folder ID
    store.setCurrentFolderId(testFolderId);

    // Assert
    const state = store.getState();
    expect(state.currentFolderId).toBe(testFolderId);
    expect(state.folderStates[testFolderId]).toBeDefined();
    expect(state.folderStates[testFolderId].lastAccessed).toBeGreaterThan(0);
    // Check if default values were set correctly in the new state
    expect(state.selectedFilePaths.size).toBe(0);
    expect(state.expandedDirectoryPaths.size).toBe(0);
  });

  it('should hydrate state with stored folder state when folder id is provided', () => {
    // Arrange
    const testFolderId = 'testFolder123';
    const customFilters = ['*.tsx'];
    const customExcludeFilters = ['node_modules'];
    const selectedPaths = new Set(['path1', 'path2']); // Composite keys not needed for mock data
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

    // Set initial folder state directly for the test
    store.setState((state: FileExplorerState) => ({
      ...state,
      folderStates: {
        [testFolderId]: initialFolderState,
      },
    }));

    // Act
    store.hydrateFolderState(testFolderId); // This action should update the top-level state

    // Assert
    const state = store.getState();
    // Check that top-level state matches the hydrated state
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
    // Arrange - store with initial values
    const initialSelectedPaths = new Set(['initial']);
    const initialExpandedPaths = new Set(['initialDir']);
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: initialSelectedPaths,
      expandedDirectoryPaths: initialExpandedPaths,
      // Keep other fields as they are from initialState
    }));

    const stateBeforeHydrate = store.getState();

    // Act - try to hydrate with non-existent folder id
    store.hydrateFolderState('nonExistentFolder');

    // Assert - state should not change
    const stateAfterHydrate = store.getState();
    expect(stateAfterHydrate.selectedFilePaths).toEqual(initialSelectedPaths);
    expect(stateAfterHydrate.expandedDirectoryPaths).toEqual(initialExpandedPaths);
    // Check a few other properties to be sure
    expect(stateAfterHydrate.includeFilters).toEqual(stateBeforeHydrate.includeFilters);
    expect(stateAfterHydrate.maxSelectionCount).toEqual(stateBeforeHydrate.maxSelectionCount);
  });

  it('should clean up oldest folder states when exceeding the maximum limit on setCurrentFolderId', () => {
    // Arrange - create multiple folder states
    const now = Date.now();
    const folderStates: Record<string, FolderState> = {};
    const numFolders = MAX_FOLDER_STATES + 5; // Exceed limit

    for (let i = 0; i < numFolders; i++) {
      const id = `folder${i}`;
      folderStates[id] = {
        lastAccessed: now - (numFolders - i) * 1000, // Oldest first
        selectedFilePaths: new Set([`${id}-file`]), // Unique data per folder
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
    }));

    expect(Object.keys(store.getState().folderStates).length).toBe(numFolders); // Verify setup

    // Act - set a new folder ID, triggering cleanup within the action
    store.setCurrentFolderId('newFolder');

    // Assert
    const finalState = store.getState();
    const finalFolderKeys = Object.keys(finalState.folderStates);

    expect(finalFolderKeys.length).toBe(MAX_FOLDER_STATES); // Should be pruned to the limit

    // The oldest folders (folder0 to folder4) should be removed
    for (let i = 0; i < 5; i++) {
      expect(finalState.folderStates[`folder${i}`]).toBeUndefined();
    }
    // The newest folders should remain
    expect(finalState.folderStates[`folder${numFolders - 1}`]).toBeDefined();
    // The newly added folder should be present
    expect(finalState.folderStates.newFolder).toBeDefined();
    expect(finalState.currentFolderId).toBe('newFolder');
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
