import type { FileExplorerState } from '@brainstrike/types';
import {
  DEFAULT_STATE,
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MIN_MAX_SELECTION_COUNT,
} from '@brainstrike/types';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla'; // Use vanilla store for testing actions
import { createDirectoryExpansionActions } from '../src/actions/directory-expansion-actions';
import { createFileSelectionActions } from '../src/actions/file-selection-actions';
import { createFolderStateActions } from '../src/actions/folder-state-actions';
import { createSettingsActions } from '../src/actions/settings-actions';

// Combine all action interfaces
type TestActions = ReturnType<typeof createFolderStateActions> &
  ReturnType<typeof createFileSelectionActions> &
  ReturnType<typeof createDirectoryExpansionActions> &
  ReturnType<typeof createSettingsActions>;

import type { StoreApi } from 'zustand/vanilla'; // Import StoreApi

describe('useFileExplorerStore Actions Integration', () => {
  let store: {
    // Use the actual setState type from StoreApi for accuracy
    setState: StoreApi<FileExplorerState>['setState'];
    getState: () => FileExplorerState;
  } & TestActions;

  const getInitialState = (): FileExplorerState => ({
    ...DEFAULT_STATE, // Start with defaults
    lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files', // Ensure default
    currentFolderId: null,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    folderStates: {},
    // Add mock implementations for all actions
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
  });

  beforeEach(() => {
    // Create a new vanilla store instance for each test
    const zustandStore = createStore<FileExplorerState>(getInitialState);

    // Initialize all action groups
    const folderActions = createFolderStateActions(zustandStore.setState, zustandStore.getState);
    const selectionActions = createFileSelectionActions(
      zustandStore.setState,
      zustandStore.getState
    );
    const expansionActions = createDirectoryExpansionActions(
      zustandStore.setState,
      zustandStore.getState
    );
    const settingsActions = createSettingsActions(zustandStore.setState, zustandStore.getState);

    // Combine actions and add them to the store's state for the test setup
    const allActions = {
      ...folderActions,
      ...selectionActions,
      ...expansionActions,
      ...settingsActions,
    };
    zustandStore.setState(allActions);

    // Create the combined store object for testing
    store = {
      setState: zustandStore.setState,
      getState: zustandStore.getState,
      ...allActions,
    };
  });

  describe('file selection actions', () => {
    const folderId = 'test-folder';
    const filePath1 = 'test1.ts';
    const filePath2 = 'test2.ts';
    const compositeKey1 = encodeFileSelection(folderId, filePath1);
    const compositeKey2 = encodeFileSelection(folderId, filePath2);

    it('addSelectedFile should add a file using composite key', () => {
      store.addSelectedFile(folderId, filePath1);
      const state = store.getState();
      expect(state.selectedFilePaths.has(compositeKey1)).toBe(true);
      expect(isPathSelectedInFolder(state.selectedFilePaths, folderId, filePath1)).toBe(true);
    });

    it('removeSelectedFile should remove a file using composite key', () => {
      store.addSelectedFile(folderId, filePath1); // Add first
      store.removeSelectedFile(folderId, filePath1);
      const state = store.getState();
      expect(state.selectedFilePaths.has(compositeKey1)).toBe(false);
      expect(isPathSelectedInFolder(state.selectedFilePaths, folderId, filePath1)).toBe(false);
    });

    it('clearSelectedFiles should remove all files', () => {
      store.addSelectedFile(folderId, filePath1);
      store.addSelectedFile(folderId, filePath2);
      store.clearSelectedFiles();
      const state = store.getState();
      expect(state.selectedFilePaths.size).toBe(0);
    });

    it('setSelectedFiles should replace selection (only with valid composite keys)', () => {
      const validSet = new Set([compositeKey1, compositeKey2]);
      const invalidSet = new Set([compositeKey1, 'invalid-key', compositeKey2]);

      store.setSelectedFiles(validSet);
      let state = store.getState();
      expect(state.selectedFilePaths).toEqual(validSet);

      // Test with invalid keys - should only keep valid ones
      store.setSelectedFiles(invalidSet);
      state = store.getState();
      expect(state.selectedFilePaths.size).toBe(2);
      expect(state.selectedFilePaths.has(compositeKey1)).toBe(true);
      expect(state.selectedFilePaths.has(compositeKey2)).toBe(true);
      expect(state.selectedFilePaths.has('invalid-key')).toBe(false);
    });

    it('toggleSelectedFile should add if not present and remove if present', () => {
      // Toggle on
      store.toggleSelectedFile(folderId, filePath1);
      let state = store.getState();
      expect(state.selectedFilePaths.has(compositeKey1)).toBe(true);

      // Toggle off
      store.toggleSelectedFile(folderId, filePath1);
      state = store.getState();
      expect(state.selectedFilePaths.has(compositeKey1)).toBe(false);
    });

    it('addSelectedFile should respect maxSelectionCount', () => {
      store.setMaxSelectionCount(2); // Use the settings action
      store.addSelectedFile(folderId, 'file1.ts');
      store.addSelectedFile(folderId, 'file2.ts');
      store.addSelectedFile(folderId, 'file3.ts'); // Should not be added

      const state = store.getState();
      expect(state.selectedFilePaths.size).toBe(2);
      expect(isPathSelectedInFolder(state.selectedFilePaths, folderId, 'file3.ts')).toBe(false);
    });

    it('toggleSelectedFile should respect maxSelectionCount when adding', () => {
      store.setMaxSelectionCount(2);
      store.addSelectedFile(folderId, 'file1.ts');
      store.addSelectedFile(folderId, 'file2.ts');

      // Try toggling a new file on (should fail)
      store.toggleSelectedFile(folderId, 'file3.ts');
      let state = store.getState();
      expect(state.selectedFilePaths.size).toBe(2);
      expect(isPathSelectedInFolder(state.selectedFilePaths, folderId, 'file3.ts')).toBe(false);

      // Toggle existing file off
      store.toggleSelectedFile(folderId, 'file1.ts');
      state = store.getState();
      expect(state.selectedFilePaths.size).toBe(1);

      // Now toggle new file on (should succeed)
      store.toggleSelectedFile(folderId, 'file3.ts');
      state = store.getState();
      expect(state.selectedFilePaths.size).toBe(2);
      expect(isPathSelectedInFolder(state.selectedFilePaths, folderId, 'file3.ts')).toBe(true);
    });
  });

  describe('directory expansion actions', () => {
    const dirPath1 = 'src';
    const dirPath2 = 'src/components';
    const dirPath3 = 'src/components/ui';

    it('toggleDirectoryExpansion should add path if not present', () => {
      store.toggleDirectoryExpansion(dirPath1);
      expect(store.getState().expandedDirectoryPaths.has(dirPath1)).toBe(true);
    });

    it('toggleDirectoryExpansion should remove path and descendants if present', () => {
      // Expand parent and children
      store.toggleDirectoryExpansion(dirPath1);
      store.toggleDirectoryExpansion(dirPath2);
      store.toggleDirectoryExpansion(dirPath3);
      expect(store.getState().expandedDirectoryPaths.has(dirPath1)).toBe(true);
      expect(store.getState().expandedDirectoryPaths.has(dirPath2)).toBe(true);
      expect(store.getState().expandedDirectoryPaths.has(dirPath3)).toBe(true);

      // Collapse parent (dirPath2)
      store.toggleDirectoryExpansion(dirPath2);
      const state = store.getState();

      // Check parent and child are collapsed, but grandparent remains
      expect(state.expandedDirectoryPaths.has(dirPath1)).toBe(true); // Grandparent
      expect(state.expandedDirectoryPaths.has(dirPath2)).toBe(false); // Parent
      expect(state.expandedDirectoryPaths.has(dirPath3)).toBe(false); // Child
    });

    it('setExpandedPaths should replace the current set', () => {
      store.toggleDirectoryExpansion('old/path');
      const newPaths = new Set([dirPath1, dirPath2]);
      store.setExpandedPaths(newPaths);
      expect(store.getState().expandedDirectoryPaths).toEqual(newPaths);
    });

    it('collapseAllDirectories should clear the set', () => {
      store.toggleDirectoryExpansion(dirPath1);
      store.toggleDirectoryExpansion(dirPath2);
      store.collapseAllDirectories();
      expect(store.getState().expandedDirectoryPaths.size).toBe(0);
    });

    // expandAllDirectories test remains in its own file (use-file-explorer-store.expand-collapse.test.ts)
  });

  describe('settings actions', () => {
    it('setFilters should update include and exclude filters', () => {
      const include = ['*.ts', '*.tsx'];
      const exclude = ['node_modules', '*.log'];
      store.setFilters(include, exclude);
      const state = store.getState();
      expect(state.includeFilters).toEqual(include);
      expect(state.excludeFilters).toEqual(exclude);
      // Ensure they are new arrays, not the same reference
      expect(state.includeFilters).not.toBe(include);
      expect(state.excludeFilters).not.toBe(exclude);
    });

    it('setUseRegex should update the boolean flag', () => {
      store.setUseRegex(true);
      expect(store.getState().useRegex).toBe(true);
      store.setUseRegex(false);
      expect(store.getState().useRegex).toBe(false);
    });

    it('setIncludeProjectTree should update the boolean flag', () => {
      store.setIncludeProjectTree(false);
      expect(store.getState().includeProjectTree).toBe(false);
      store.setIncludeProjectTree(true);
      expect(store.getState().includeProjectTree).toBe(true);
    });

    it('setFolderSummaryThreshold should update and clamp the value', () => {
      store.setFolderSummaryThreshold(50);
      expect(store.getState().folderSummaryThreshold).toBe(50);

      // Test clamping at lower bound
      store.setFolderSummaryThreshold(-10);
      expect(store.getState().folderSummaryThreshold).toBe(0);

      // Test clamping at upper bound
      store.setFolderSummaryThreshold(MAX_FOLDER_SUMMARY_THRESHOLD + 100);
      expect(store.getState().folderSummaryThreshold).toBe(MAX_FOLDER_SUMMARY_THRESHOLD);
    });

    it('setMaxSelectionCount should update and clamp the value', () => {
      store.setMaxSelectionCount(50);
      expect(store.getState().maxSelectionCount).toBe(50);

      // Test clamping at lower bound
      store.setMaxSelectionCount(MIN_MAX_SELECTION_COUNT - 5);
      expect(store.getState().maxSelectionCount).toBe(MIN_MAX_SELECTION_COUNT);

      // Test clamping at upper bound
      store.setMaxSelectionCount(MAX_SELECTION_COUNT + 100);
      expect(store.getState().maxSelectionCount).toBe(MAX_SELECTION_COUNT);
    });

    it('setLastActiveTab should update the tab string', () => {
      store.setLastActiveTab('preview');
      expect(store.getState().lastActiveTab).toBe('preview');
      store.setLastActiveTab('files');
      expect(store.getState().lastActiveTab).toBe('files');
    });
  });

  // Persistence/Rehydration aspects are implicitly tested by setup/initial state checks
  // Folder state switching logic is tested in use-file-explorer-store.folder-state-actions.test.ts
});
