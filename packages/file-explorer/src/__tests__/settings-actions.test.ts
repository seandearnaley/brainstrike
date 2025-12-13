import { createMemoryStorageAdapter } from '@brainstrike/storage';
import {
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MAX_TOKEN_BUDGET,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  MIN_TOKEN_BUDGET,
} from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { createFileExplorerStore } from '../store';

describe('settings-actions', () => {
  const makeStore = () => createFileExplorerStore(createMemoryStorageAdapter());

  it('clamps maxSelectionCount and trims selection set when reduced', () => {
    const store = makeStore();
    const s = store.getState();

    // Add three selected files
    s.addSelectedFile('root', '/a');
    s.addSelectedFile('root', '/b');
    s.addSelectedFile('root', '/c');
    expect(store.getState().selectedFilePaths.size).toBe(3);

    // Set below min => clamp to MIN_MAX_SELECTION_COUNT
    s.setMaxSelectionCount(0);
    expect(store.getState().maxSelectionCount).toBe(MIN_MAX_SELECTION_COUNT);

    // Grow above max => clamp to MAX_SELECTION_COUNT
    s.setMaxSelectionCount(MAX_SELECTION_COUNT + 100);
    expect(store.getState().maxSelectionCount).toBe(MAX_SELECTION_COUNT);

    // After clamping to 1 above, selection should have been trimmed to 1
    expect(store.getState().selectedFilePaths.size).toBe(1);

    // Increase limit; existing selection stays at 1 until more are added
    s.setMaxSelectionCount(2);
    expect(store.getState().maxSelectionCount).toBe(2);
    expect(store.getState().selectedFilePaths.size).toBe(1);
  });

  it('clamps folderSummaryThreshold within bounds', () => {
    const store = makeStore();
    const s = store.getState();

    s.setFolderSummaryThreshold(-10);
    expect(store.getState().folderSummaryThreshold).toBe(MIN_FOLDER_SUMMARY_THRESHOLD);

    s.setFolderSummaryThreshold(MAX_FOLDER_SUMMARY_THRESHOLD + 1);
    expect(store.getState().folderSummaryThreshold).toBe(MAX_FOLDER_SUMMARY_THRESHOLD);
  });

  it('updates include/exclude filters arrays', () => {
    const store = makeStore();
    const s = store.getState();
    s.setFilters(['*.ts', 'src/**'], ['node_modules/**']);
    expect(store.getState().includeFilters).toEqual(['*.ts', 'src/**']);
    expect(store.getState().excludeFilters).toEqual(['node_modules/**']);
  });

  it('toggles useRegex and includeProjectTree', () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.useRegex).toBe(false);
    expect(s.includeProjectTree).toBe(true);

    s.setUseRegex(true);
    s.setIncludeProjectTree(false);
    expect(store.getState().useRegex).toBe(true);
    expect(store.getState().includeProjectTree).toBe(false);
  });

  it('persists tokenBudget to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');

    s.setTokenBudget(42);
    expect(store.getState().tokenBudget).toBe(42);
    expect(store.getState().folderStates.root?.tokenBudget).toBe(42);

    s.setTokenBudget(MIN_TOKEN_BUDGET - 100);
    expect(store.getState().tokenBudget).toBe(MIN_TOKEN_BUDGET);
    expect(store.getState().folderStates.root?.tokenBudget).toBe(MIN_TOKEN_BUDGET);

    s.setTokenBudget(MAX_TOKEN_BUDGET + 100);
    expect(store.getState().tokenBudget).toBe(MAX_TOKEN_BUDGET);
    expect(store.getState().folderStates.root?.tokenBudget).toBe(MAX_TOKEN_BUDGET);
  });
});
