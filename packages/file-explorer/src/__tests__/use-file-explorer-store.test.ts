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
import { createNewFolderState, getForeignSelectionCount } from '../utils/file-explorer-utils';

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
    addMultipleSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    clearAllFileContents: vi.fn(),
    clearFileContents: vi.fn(),
    clearSelectedFiles: vi.fn(),
    collapseAllDirectories: vi.fn(),
    currentFolderId: null,
    expandAllDirectories: vi.fn(),
    expandedDirectoryPaths: new Set<string>(),
    folderStates: {},
    hydrateFolderState: vi.fn(),
    lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files', // Ensure default
    removeMultipleSelectedFiles: vi.fn(),
    removeSelectedFile: vi.fn(),
    selectedFilePaths: new Set<string>(),
    // Add mock implementations for all actions
    setCurrentFolderId: vi.fn(),
    setExpandedPaths: vi.fn(),
    setFileContent: vi.fn(),
    setFilters: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setLastActiveTab: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setSelectedFiles: vi.fn(),
    setUseRegex: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    toggleSelectedFile: vi.fn(),
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
      getState: zustandStore.getState,
      setState: zustandStore.setState,
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
      // The forest-union cap counts ACTIVE roots only.
      store.setState({ activeRootIds: [ROOT_A, ROOT_B] });
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

    // FOREST INVARIANT: folderState selections are ALWAYS explicit. A query
    // selection lives on TOP-LEVEL state (manifest + descriptor) the focused
    // root owns — snapshotting the query model verbatim loses the selection
    // on focus switch (P6fix round 7: "select all works on one root, then
    // the others stop responding").
    it('focus switch MATERIALIZES a query-mode selection into the outgoing snapshot', () => {
      store.setState({
        querySelectionManifest: {
          directoryCounts: new Map(),
          errorMessage: null,
          filePaths: ['/a/x.ts', '/a/y.ts'],
          fingerprint: 'fp',
          pathSet: new Set(['/a/x.ts', '/a/y.ts']),
          snapshotId: null,
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: null,
          ruleSetJson: null,
        },
      });

      store.setCurrentFolderId(ROOT_B);

      const snapshot = store.getState().folderStates[ROOT_A];
      expect(snapshot?.selectionModel.mode).toBe('explicit');
      expect(snapshot?.selectedFilePaths).toEqual(new Set([keyA('/a/x.ts'), keyA('/a/y.ts')]));
      expect(snapshot?.selectionModel.explicitPaths).toEqual(
        new Set([keyA('/a/x.ts'), keyA('/a/y.ts')])
      );
    });

    it('focus switch materializes RULES selections into the snapshot keys but KEEPS the rules model', () => {
      // Rules carry the user's rule set inside the model — destroying it on
      // focus switch would silently delete their rules. The snapshot keys are
      // still materialized so foreign counts/budgets/root checkboxes see the
      // selection (folderState.selectedFilePaths is the counts contract).
      store.setState({
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2026-06-12T00:00:00Z',
          materializedPaths: new Set(['src/a.ts', 'src/b.ts']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"include":["*.ts"]}',
        },
      });

      store.setCurrentFolderId(ROOT_B);

      const snapshot = store.getState().folderStates[ROOT_A];
      expect(snapshot?.selectionModel.mode).toBe('rules');
      expect(snapshot?.selectionModel.ruleSetJson).toBe('{"include":["*.ts"]}');
      expect(snapshot?.selectedFilePaths).toEqual(new Set([keyA('src/a.ts'), keyA('src/b.ts')]));
      // The foreign budget now SEES the rules selection.
      expect(
        getForeignSelectionCount({
          activeRootIds: [ROOT_A, ROOT_B],
          currentFolderId: ROOT_B,
          folderStates: store.getState().folderStates,
        })
      ).toBe(2);
    });

    it('refocusing a root with a rules snapshot restores the RULES model intact', () => {
      store.setState({
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2026-06-12T00:00:00Z',
          materializedPaths: new Set(['src/a.ts']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"include":["*.ts"]}',
        },
      });
      store.setCurrentFolderId(ROOT_B);

      store.setCurrentFolderId(ROOT_A);

      const s = store.getState();
      expect(s.selectionModel.mode).toBe('rules');
      expect(s.selectionModel.ruleSetJson).toBe('{"include":["*.ts"]}');
      expect(s.selectionModel.materializedPaths).toEqual(new Set(['src/a.ts']));
    });

    it('hydrating a stale query-mode snapshot in forest mode degrades it to explicit', () => {
      // Pre-invariant profiles persisted query models into folderStates; the
      // manifest they reference is gone, so restoring them verbatim creates a
      // phantom selection (counts/checkboxes disagree with the actual keys).
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: {
            ...createNewFolderState(),
            selectedFilePaths: new Set([keyB('x.ts')]),
            selectionModel: {
              explicitPaths: new Set<string>(),
              materializedAt: null,
              materializedPaths: null,
              mode: 'query',
              queryDescriptor: null,
              ruleSetJson: null,
            },
          },
        },
      });

      store.setCurrentFolderId(ROOT_B);

      const s = store.getState();
      expect(s.selectionModel.mode).toBe('explicit');
      expect(s.selectionModel.explicitPaths).toEqual(new Set([keyB('x.ts')]));
      expect(s.selectedFilePaths).toEqual(new Set([keyB('x.ts')]));
    });

    // Hardening B: the LAST per-folder hydrated settings join the
    // WORKSPACE-GLOBAL doctrine. Forest mode focus-switches on every section
    // click — hydrating these from folder snapshots flips the user's token
    // budget / project-tree toggle / summary threshold / ACTIVE TAB per
    // clicked root.
    it('focus switch does NOT hydrate tokenBudget/includeProjectTree/folderSummaryThreshold/lastActiveTab', () => {
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_B]: {
            ...createNewFolderState(),
            folderSummaryThreshold: 7,
            includeProjectTree: true,
            lastActiveTab: 'files',
            tokenBudget: 1000,
          },
        },
        folderSummaryThreshold: 42,
        includeProjectTree: false,
        lastActiveTab: 'curated',
        tokenBudget: 150_000,
      });

      store.setCurrentFolderId(ROOT_B);

      const s = store.getState();
      expect(s.tokenBudget).toBe(150_000);
      expect(s.includeProjectTree).toBe(false);
      expect(s.folderSummaryThreshold).toBe(42);
      expect(s.lastActiveTab).toBe('curated');
    });

    it('hydrateFolderState does NOT hydrate the workspace-global report/tab settings', () => {
      store.setState({
        folderStates: {
          ...store.getState().folderStates,
          [ROOT_A]: {
            ...createNewFolderState(),
            folderSummaryThreshold: 7,
            includeProjectTree: true,
            lastActiveTab: 'files',
            tokenBudget: 1000,
          },
        },
        folderSummaryThreshold: 42,
        includeProjectTree: false,
        lastActiveTab: 'curated',
        tokenBudget: 150_000,
      });

      store.hydrateFolderState(ROOT_A);

      const s = store.getState();
      expect(s.tokenBudget).toBe(150_000);
      expect(s.includeProjectTree).toBe(false);
      expect(s.folderSummaryThreshold).toBe(42);
      expect(s.lastActiveTab).toBe('curated');
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
            excludeFilters: ['node_modules'],
            includeFilters: ['*.ts'],
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
            maxSelectionCount: 2,
            selectedFilePaths: new Set([keyB('seed.ts')]),
          },
        },
      });

      store.addMultipleSelectedFiles(ROOT_B, ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts']);

      expect(store.getState().folderStates[ROOT_B]?.selectedFilePaths.size).toBe(5);
    });

    // maxSelectionCount caps the WHOLE-FOREST UNION, not each tree
    // independently — otherwise every root could take the full cap.
    it('top-level adds respect the forest-union cap (foreign selections consume budget)', () => {
      store.setMaxSelectionCount(5);
      // Root B (non-focused) already holds 4 selections.
      store.addMultipleSelectedFiles(ROOT_B, ['b1.ts', 'b2.ts', 'b3.ts', 'b4.ts']);

      // Focused root A tries to add 3 — only 1 slot remains in the union.
      store.addMultipleSelectedFiles(ROOT_A, ['a1.ts', 'a2.ts', 'a3.ts']);

      const s = store.getState();
      expect(s.folderStates[ROOT_B]?.selectedFilePaths.size).toBe(4);
      expect(s.selectedFilePaths.size).toBe(1);
    });

    it('foreign adds respect the forest-union cap (focused selection consumes budget)', () => {
      store.setMaxSelectionCount(5);
      // Focused root A holds 4 selections.
      store.addMultipleSelectedFiles(ROOT_A, ['a1.ts', 'a2.ts', 'a3.ts', 'a4.ts']);

      // Foreign root B tries to add 3 — only 1 slot remains in the union.
      store.addMultipleSelectedFiles(ROOT_B, ['b1.ts', 'b2.ts', 'b3.ts']);

      const s = store.getState();
      expect(s.selectedFilePaths.size).toBe(4);
      expect(s.folderStates[ROOT_B]?.selectedFilePaths.size).toBe(1);
    });

    it('single adds are blocked once the forest union reaches the cap', () => {
      store.setMaxSelectionCount(2);
      store.addSelectedFile(ROOT_A, 'a1.ts');
      store.addSelectedFile(ROOT_B, 'b1.ts');

      // Union is at the cap (1 + 1) — both targets are now blocked.
      store.addSelectedFile(ROOT_A, 'a2.ts');
      store.addSelectedFile(ROOT_B, 'b2.ts');

      const s = store.getState();
      expect(s.selectedFilePaths.size).toBe(1);
      expect(s.folderStates[ROOT_B]?.selectedFilePaths.size).toBe(1);
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
