import type { FileExplorerState, FolderState } from '@brainstrike/types';
import {
  createEmptySelectionModel,
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_STATE,
  DEFAULT_TOKEN_BUDGET,
  MAX_FOLDER_STATES,
  MIN_MAX_SELECTION_COUNT,
} from '@brainstrike/types';
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
    expandedDirectoryPaths: new Set<string>(),
    folderStates: {},
    lastActiveTab: 'files' as const,
    selectedFilePaths: new Set<string>(),
  });

  beforeEach(() => {
    const zustandStore = createStore<FileExplorerState>(
      () =>
        ({
          ...getInitialState(),
          addSelectedFile: vi.fn(),
          clearSelectedFiles: vi.fn(),
          collapseAllDirectories: vi.fn(),
          expandAllDirectories: vi.fn(),
          hydrateFolderState: vi.fn(),
          removeSelectedFile: vi.fn(),
          // These will be overwritten by the real actions, but TypeScript needs them
          setCurrentFolderId: vi.fn(),
          setExpandedPaths: vi.fn(),
          setFilters: vi.fn(),
          setFolderSummaryThreshold: vi.fn(),
          setIncludeProjectTree: vi.fn(),
          setLastActiveTab: vi.fn(),
          setMaxSelectionCount: vi.fn(),
          setSelectedFiles: vi.fn(),
          setUseRegex: vi.fn(),
          toggleDirectoryExpansion: vi.fn(),
          toggleSelectedFile: vi.fn(),
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
      getState: zustandStore.getState,
      setState: zustandStore.setState,
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
      expandedDirectoryPaths: new Set(['dir1']),
      selectedFilePaths: new Set(['file1']),
    }));

    store.setCurrentFolderId('newId');

    const state = store.getState();
    expect(state.currentFolderId).toBe('newId');
    const idKey = 'newId';
    const newState = state.folderStates[idKey];
    expect(newState).toBeDefined();
    if (!newState) {
      throw new Error('Expected folder state to be defined');
    }
    expect(newState.selectedFilePaths.size).toBe(0);
    expect(newState.expandedDirectoryPaths.size).toBe(0);
    expect(newState.useRegex).toBe(false);
    expect(newState.includeProjectTree).toBe(true);
    expect(newState.folderSummaryThreshold).toBe(DEFAULT_FOLDER_SUMMARY_THRESHOLD);
    expect(newState.maxSelectionCount).toBe(DEFAULT_MAX_SELECTION_COUNT);
    expect(newState.lastActiveTab).toBe('files');
    expect(newState.lastAccessed).toBeGreaterThan(0);
    expect(state.selectedFilePaths.size).toBe(0);
    // expandedDirectoryPaths is WORKSPACE-GLOBAL — switching to a new folder
    // must not collapse other sections' expansions (forest mode).
    expect(state.expandedDirectoryPaths).toEqual(new Set(['dir1']));
  });

  it('should hydrate state with stored folder state when folder id is provided', () => {
    const testFolderId = 'testFolder123';
    const customFilters = ['*.tsx'];
    const customExcludeFilters = ['node_modules'];
    const selectedPaths = new Set(['path1', 'path2']);
    const expandedPaths = new Set(['dir1']);

    const initialFolderState: FolderState = {
      excludeFilters: customExcludeFilters,
      expandedDirectoryPaths: expandedPaths,
      folderSummaryThreshold: 10,
      includeFilters: customFilters,
      includeProjectTree: false,
      lastAccessed: Date.now(),
      lastActiveTab: 'settings',
      maxSelectionCount: 50,
      selectedFilePaths: selectedPaths,
      selectionModel: createEmptySelectionModel(),
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      useRegex: true,
      viewFilterPresetId: null,
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
    // WORKSPACE-GLOBAL settings (view filters, useRegex, maxSelectionCount,
    // expandedDirectoryPaths) are never hydrated from folder snapshots — the
    // top-level values stay.
    expect(state.expandedDirectoryPaths).toEqual(DEFAULT_STATE.expandedDirectoryPaths);
    expect(state.includeFilters).toEqual(DEFAULT_STATE.includeFilters);
    expect(state.excludeFilters).toEqual(DEFAULT_STATE.excludeFilters);
    expect(state.useRegex).toBe(DEFAULT_STATE.useRegex);
    expect(state.maxSelectionCount).toBe(DEFAULT_STATE.maxSelectionCount);
    // Hardening B: tokenBudget/includeProjectTree/folderSummaryThreshold/
    // lastActiveTab joined the WORKSPACE-GLOBAL doctrine — never hydrated.
    expect(state.includeProjectTree).toBe(DEFAULT_STATE.includeProjectTree);
    expect(state.folderSummaryThreshold).toBe(DEFAULT_STATE.folderSummaryThreshold);
    expect(state.lastActiveTab).toBe(DEFAULT_STATE.lastActiveTab);
  });

  it('should not change state if hydrating with a non-existent folder id', () => {
    const initialSelectedPaths = new Set(['initial']);
    const initialExpandedPaths = new Set(['initialDir']);
    store.setState((state: FileExplorerState) => ({
      ...state,
      expandedDirectoryPaths: initialExpandedPaths,
      selectedFilePaths: initialSelectedPaths,
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
        excludeFilters: [],
        expandedDirectoryPaths: new Set([`${id}-dir`]),
        folderSummaryThreshold: 5,
        includeFilters: [],
        includeProjectTree: true,
        lastAccessed: now - (numFolders - i) * 1000,
        lastActiveTab: 'files',
        maxSelectionCount: 100,
        selectedFilePaths: new Set([`${id}-file`]),
        selectionModel: createEmptySelectionModel(),
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        useRegex: false,
        viewFilterPresetId: null,
      };
    }

    store.setState((state: FileExplorerState) => ({
      ...state,
      folderAccessOrder: Object.keys(folderStates),
      folderStates,
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

  it('setFolderSelection writes a non-focused root selection without touching the focused state', () => {
    const ROOT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ROOT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
    const KEY_B1 = `${ROOT_B}|@|src/one.ts`;
    const KEY_B2 = `${ROOT_B}|@|src/two.ts`;

    // Focus root A with a live selection.
    store.setCurrentFolderId(ROOT_A);
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: new Set([`${ROOT_A}|@|a.ts`]),
    }));

    // Write B's selection directly (cross-root deselect/select path) — B has
    // no folderState yet, so the action must create one from the reset shape.
    store.setFolderSelection(ROOT_B, [KEY_B1, KEY_B2]);

    const state = store.getState();
    // Focused state untouched.
    expect(state.currentFolderId).toBe(ROOT_A);
    expect(state.selectedFilePaths).toEqual(new Set([`${ROOT_A}|@|a.ts`]));
    // B's folderState carries the selection in BOTH the set and the model.
    expect(state.folderStates[ROOT_B]?.selectedFilePaths).toEqual(new Set([KEY_B1, KEY_B2]));
    expect(state.folderStates[ROOT_B]?.selectionModel.mode).toBe('explicit');
    expect(state.folderStates[ROOT_B]?.selectionModel.explicitPaths).toEqual(
      new Set([KEY_B1, KEY_B2])
    );

    // Overwriting with an empty list clears B without touching A.
    store.setFolderSelection(ROOT_B, []);
    expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths).toEqual(new Set());
    expect(store.getState().selectedFilePaths).toEqual(new Set([`${ROOT_A}|@|a.ts`]));
  });

  it('keeps distinct folder states and composite keys for two same-named roots with different RootIds', () => {
    // Storage v5 regression: two roots can share the same display name
    // (e.g. both folders are called "project"). Their identity is the durable
    // RootId UUID, so their folderStates entries and `<rootId>|@|<path>`
    // composite selection keys must never collide.
    const ROOT_A = 'aaaaaaaa-0000-0000-0000-000000000001'; // display name "project"
    const ROOT_B = 'bbbbbbbb-0000-0000-0000-000000000002'; // display name "project" (same)
    const RELATIVE_PATH = 'src/index.ts'; // identical relative path in both roots

    // Activate root A and select a file under it.
    store.setCurrentFolderId(ROOT_A);
    store.setState((state: FileExplorerState) => ({
      ...state,
      expandedDirectoryPaths: new Set(['src']),
      selectedFilePaths: new Set([`${ROOT_A}|@|${RELATIVE_PATH}`]),
    }));

    // Switch to root B — A's selection must NOT leak into B.
    // (Expansion is WORKSPACE-GLOBAL and intentionally persists.)
    store.setCurrentFolderId(ROOT_B);
    expect(store.getState().selectedFilePaths.size).toBe(0);
    expect(store.getState().expandedDirectoryPaths).toEqual(new Set(['src']));
    store.setState((state: FileExplorerState) => ({
      ...state,
      selectedFilePaths: new Set([`${ROOT_B}|@|${RELATIVE_PATH}`]),
    }));

    // Switch back to A — distinct entries, per-root state restored intact.
    store.setCurrentFolderId(ROOT_A);
    const state = store.getState();
    expect(Object.keys(state.folderStates).sort()).toEqual([ROOT_A, ROOT_B].sort());
    expect(state.selectedFilePaths).toEqual(new Set([`${ROOT_A}|@|${RELATIVE_PATH}`]));
    expect(state.expandedDirectoryPaths).toEqual(new Set(['src']));
    // B's saved state keeps ITS composite key — same relative path, different identity.
    expect(state.folderStates[ROOT_B]?.selectedFilePaths).toEqual(
      new Set([`${ROOT_B}|@|${RELATIVE_PATH}`])
    );
  });

  it('should reset current state fields when setting current folder ID to null', () => {
    // Arrange - set some state values and a current folder
    const folderToSave = 'someFolder';
    const selectedPaths = new Set(['file1', 'file2']);
    const expandedPaths = new Set(['dir1', 'dir2']);

    store.setState((state: FileExplorerState) => ({
      ...state,
      currentFolderId: folderToSave,
      expandedDirectoryPaths: expandedPaths,
      includeFilters: ['*.*'], // Give some non-default values to save
      selectedFilePaths: selectedPaths,
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
      maxSelectionCount: 10, // Initial max count
      selectedFilePaths: selectedFiles,
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
