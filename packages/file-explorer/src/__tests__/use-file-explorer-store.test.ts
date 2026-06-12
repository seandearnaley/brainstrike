import type { FileExplorerState } from '@brainstrike/types';
import {
  DEFAULT_STATE,
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MIN_MAX_SELECTION_COUNT,
} from '@brainstrike/types';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla'; // Use vanilla store for testing actions
import { createDirectoryExpansionActions } from '../actions/directory-expansion-actions';
import { createFileContentActions } from '../actions/file-content-actions';
import { createFileSelectionActions } from '../actions/file-selection-actions';
import { createFolderStateActions } from '../actions/folder-state-actions';
import { createSettingsActions } from '../actions/settings-actions';
import { createNewFolderState } from '../utils/file-explorer-utils';

// Combine all action interfaces
type TestActions = ReturnType<typeof createFolderStateActions> &
  ReturnType<typeof createFileSelectionActions> &
  ReturnType<typeof createDirectoryExpansionActions> &
  ReturnType<typeof createSettingsActions> &
  ReturnType<typeof createFileContentActions>;

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
    addMultipleSelectedFiles: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
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
    setFileContent: vi.fn(),
    clearFileContents: vi.fn(),
    clearAllFileContents: vi.fn(),
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
    const fileContentActions = createFileContentActions(
      zustandStore.setState,
      zustandStore.getState
    );

    // Combine actions and add them to the store's state for the test setup
    const allActions = {
      ...folderActions,
      ...selectionActions,
      ...expansionActions,
      ...settingsActions,
      ...fileContentActions,
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

  describe('cross-root selection routing (Phase 6 forest hardening)', () => {
    const ROOT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ROOT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
    const keyA = (p: string) => `${ROOT_A}|@|${p}`;
    const keyB = (p: string) => `${ROOT_B}|@|${p}`;

    beforeEach(() => {
      store.setCurrentFolderId(ROOT_A);
    });

    it('addSelectedFile for a NON-focused root writes its folderState, not the top-level set', () => {
      store.addSelectedFile(ROOT_B, 'x.ts');

      const s = store.getState();
      expect(s.selectedFilePaths.has(keyB('x.ts'))).toBe(false);
      expect(s.folderStates[ROOT_B]?.selectedFilePaths.has(keyB('x.ts'))).toBe(true);
      expect(s.folderStates[ROOT_B]?.selectionModel.explicitPaths.has(keyB('x.ts'))).toBe(true);
    });

    it('toggleSelectedFile toggles within the foreign folderState', () => {
      store.toggleSelectedFile(ROOT_B, 'x.ts');
      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths.has(keyB('x.ts'))).toBe(true);

      store.toggleSelectedFile(ROOT_B, 'x.ts');
      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths.has(keyB('x.ts'))).toBe(
        false
      );
      // The focused top-level set is never touched by foreign toggles.
      expect(store.getState().selectedFilePaths.size).toBe(0);
    });

    it('add/removeMultipleSelectedFiles route foreign batches to the foreign folderState', () => {
      store.addMultipleSelectedFiles(ROOT_B, ['p1.ts', 'p2.ts']);
      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths).toEqual(
        new Set([keyB('p1.ts'), keyB('p2.ts')])
      );

      store.removeMultipleSelectedFiles(ROOT_B, ['p1.ts']);
      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths).toEqual(
        new Set([keyB('p2.ts')])
      );
      expect(store.getState().selectedFilePaths.size).toBe(0);
    });

    it('write-then-focus-switch keeps the key (checkbox stays checked) and never contaminates the outgoing snapshot', () => {
      // The forest race: the checkbox handler fires BEFORE the click-bubble
      // focus switch. The foreign write must be order-independent.
      store.addSelectedFile(ROOT_A, 'a.ts'); // focused write → top-level
      store.addSelectedFile(ROOT_B, 'x.ts'); // foreign write → B's folderState
      store.setCurrentFolderId(ROOT_B); // the bubble's focus switch

      const s = store.getState();
      // B's key survives the switch into the now-focused top-level set.
      expect(s.selectedFilePaths.has(keyB('x.ts'))).toBe(true);
      // A's snapshot holds ONLY A's keys — no cross-root contamination.
      expect(s.folderStates[ROOT_A]?.selectedFilePaths).toEqual(new Set([keyA('a.ts')]));
    });

    // maxSelectionCount is a WORKSPACE-GLOBAL setting (P6fix round 2). Stale
    // per-folder snapshots (default 10) used to hydrate the top-level cap on
    // every focus switch and clamp foreign writes — in forest mode the
    // effective limit silently flipped per clicked section, making checkbox
    // clicks no-ops ("checking folders mostly doesn't work").
    it('focus switch does NOT hydrate maxSelectionCount from a stale folderState snapshot', () => {
      store.setMaxSelectionCount(100);
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: { ...createNewFolderState(), maxSelectionCount: 10 },
        },
      });

      store.setCurrentFolderId(ROOT_B);

      expect(store.getState().maxSelectionCount).toBe(100);
    });

    it('hydrateFolderState does NOT hydrate maxSelectionCount from the folderState snapshot', () => {
      store.setMaxSelectionCount(100);
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_A]: { ...createNewFolderState(), maxSelectionCount: 10 },
        },
      });

      store.hydrateFolderState(ROOT_A);

      expect(store.getState().maxSelectionCount).toBe(100);
    });

    // View filters are WORKSPACE-GLOBAL (same contract as maxSelectionCount):
    // forest mode switches focus on every section click, so per-folder filter
    // snapshots would silently revert the user's filter change per clicked
    // root ("I switched to all files and folders still say nothing matches").
    it('focus switch does NOT hydrate view filters from a stale folderState snapshot', () => {
      store.setFilters(['*.md'], ['dist']);
      store.setUseRegex(false);
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: {
            ...createNewFolderState(),
            includeFilters: ['*.ts'],
            excludeFilters: ['node_modules'],
            useRegex: true,
            viewFilterPresetId: 'stale-preset',
          },
        },
      });

      store.setCurrentFolderId(ROOT_B);

      const s = store.getState();
      expect(s.includeFilters).toEqual(['*.md']);
      expect(s.excludeFilters).toEqual(['dist']);
      expect(s.useRegex).toBe(false);
      expect(s.viewFilterPresetId).not.toBe('stale-preset');
    });

    it('hydrateFolderState does NOT hydrate view filters from the folderState snapshot', () => {
      store.setFilters(['*.md'], []);
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_A]: {
            ...createNewFolderState(),
            includeFilters: ['*.ts'],
            useRegex: true,
          },
        },
      });

      store.hydrateFolderState(ROOT_A);

      expect(store.getState().includeFilters).toEqual(['*.md']);
      expect(store.getState().useRegex).toBe(false);
    });

    // Expansion state is WORKSPACE-GLOBAL in forest mode: all section trees
    // read the one top-level set (paths are globally unique), so a focus
    // switch must never replace it with a folder snapshot — that collapsed
    // every other section's expansions on each section click.
    it('focus switch does NOT replace expandedDirectoryPaths with the folder snapshot', () => {
      store.setExpandedPaths(new Set(['/project-a/src', '/project-b/lib']));
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: {
            ...createNewFolderState(),
            expandedDirectoryPaths: new Set(['/project-b/old-only']),
          },
        },
      });

      store.setCurrentFolderId(ROOT_B);

      expect(store.getState().expandedDirectoryPaths).toEqual(
        new Set(['/project-a/src', '/project-b/lib'])
      );
    });

    it('collapseAllDirectories clears the global expansion set (every section collapses)', () => {
      store.setExpandedPaths(new Set(['/project-a/src', '/project-b/lib']));

      store.collapseAllDirectories();

      expect(store.getState().expandedDirectoryPaths.size).toBe(0);
    });

    it('foreign writes clamp against the GLOBAL maxSelectionCount, not the stale folder snapshot', () => {
      store.setMaxSelectionCount(100);
      // Seed B's folderState with a stale per-folder cap of 2.
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: {
            ...createNewFolderState(),
            selectedFilePaths: new Set([keyB('seed.ts')]),
            maxSelectionCount: 2,
          },
        },
      });

      store.addMultipleSelectedFiles(ROOT_B, ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts']);

      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths.size).toBe(5);
    });

    it('focus-switch snapshot partitions any foreign key that leaked into the top-level set', () => {
      // Defense in depth: even if a foreign key somehow lands in the focused
      // set, the switch routes it to ITS root instead of snapshotting it into
      // the outgoing root's folderState.
      store.setState({
        selectedFilePaths: new Set([keyA('a.ts'), keyB('leak.ts')]),
      });

      store.setCurrentFolderId(ROOT_B);

      const s = store.getState();
      expect(s.folderStates[ROOT_A]?.selectedFilePaths).toEqual(new Set([keyA('a.ts')]));
      // The leaked key belongs to B — now focused, it appears in the top-level set.
      expect(s.selectedFilePaths.has(keyB('leak.ts'))).toBe(true);
    });
  });
});
