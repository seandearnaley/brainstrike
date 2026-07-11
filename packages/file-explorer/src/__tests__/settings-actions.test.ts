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

  it('persists include/exclude filters to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');
    s.setFilters(['*.ts', '*.tsx'], ['node_modules/**']);

    expect(store.getState().includeFilters).toEqual(['*.ts', '*.tsx']);
    expect(store.getState().excludeFilters).toEqual(['node_modules/**']);
    expect(store.getState().folderStates['root']?.includeFilters).toEqual(['*.ts', '*.tsx']);
    expect(store.getState().folderStates['root']?.excludeFilters).toEqual(['node_modules/**']);
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

  it('persists includeProjectTree to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');
    s.setIncludeProjectTree(false);

    expect(store.getState().includeProjectTree).toBe(false);
    expect(store.getState().folderStates['root']?.includeProjectTree).toBe(false);
  });

  it('seeds a newly tracked folder from current top-level settings', () => {
    const store = makeStore();
    const s = store.getState();

    s.setIncludeProjectTree(false);
    s.setMaxSelectionCount(5);
    s.setUseRegex(true);
    s.setCurrentFolderId('root');

    expect(store.getState().folderStates['root']?.includeProjectTree).toBe(false);
    expect(store.getState().folderStates['root']?.maxSelectionCount).toBe(5);
    expect(store.getState().folderStates['root']?.useRegex).toBe(true);
  });

  it('persists maxSelectionCount to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');
    s.addSelectedFile('root', '/a');
    s.addSelectedFile('root', '/b');
    s.addSelectedFile('root', '/c');

    s.setMaxSelectionCount(2);

    expect(store.getState().maxSelectionCount).toBe(2);
    expect(store.getState().selectedFilePaths.size).toBe(2);
    expect(store.getState().folderStates['root']?.maxSelectionCount).toBe(2);
    expect(store.getState().folderStates['root']?.selectedFilePaths.size).toBe(2);
  });

  it('persists useRegex to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');
    s.setUseRegex(true);

    expect(store.getState().useRegex).toBe(true);
    expect(store.getState().folderStates['root']?.useRegex).toBe(true);
  });

  it('persists tokenBudget to the active folder state', () => {
    const store = makeStore();
    const s = store.getState();

    s.setCurrentFolderId('root');

    s.setTokenBudget(42);
    expect(store.getState().tokenBudget).toBe(42);
    expect(store.getState().folderStates['root']?.tokenBudget).toBe(42);

    s.setTokenBudget(MIN_TOKEN_BUDGET - 100);
    expect(store.getState().tokenBudget).toBe(MIN_TOKEN_BUDGET);
    expect(store.getState().folderStates['root']?.tokenBudget).toBe(MIN_TOKEN_BUDGET);

    s.setTokenBudget(MAX_TOKEN_BUDGET + 100);
    expect(store.getState().tokenBudget).toBe(MAX_TOKEN_BUDGET);
    expect(store.getState().folderStates['root']?.tokenBudget).toBe(MAX_TOKEN_BUDGET);
  });

  describe('setTokenBudget edge cases', () => {
    it('ignores NaN values', () => {
      const store = makeStore();
      const s = store.getState();
      const initialBudget = store.getState().tokenBudget;

      s.setTokenBudget(Number.NaN);
      expect(store.getState().tokenBudget).toBe(initialBudget);
    });

    it('ignores Infinity values', () => {
      const store = makeStore();
      const s = store.getState();
      const initialBudget = store.getState().tokenBudget;

      s.setTokenBudget(Number.POSITIVE_INFINITY);
      expect(store.getState().tokenBudget).toBe(initialBudget);

      s.setTokenBudget(Number.NEGATIVE_INFINITY);
      expect(store.getState().tokenBudget).toBe(initialBudget);
    });

    it('sets tokenBudget without folder state when no currentFolderId', () => {
      const store = makeStore();
      const s = store.getState();

      // Ensure no currentFolderId
      expect(store.getState().currentFolderId).toBeNull();

      s.setTokenBudget(5000);
      expect(store.getState().tokenBudget).toBe(5000);
    });

    it('sets tokenBudget when currentFolderId has no folderState', () => {
      const store = makeStore();

      // Manually set a currentFolderId without creating folderState
      store.setState({ currentFolderId: 'nonexistent-folder' });

      store.getState().setTokenBudget(6000);
      expect(store.getState().tokenBudget).toBe(6000);
      // No folderState should be created for nonexistent folder
      expect(store.getState().folderStates['nonexistent-folder']).toBeUndefined();
    });

    it('rounds fractional token budgets', () => {
      const store = makeStore();
      const s = store.getState();

      s.setTokenBudget(1000.7);
      expect(store.getState().tokenBudget).toBe(1001);

      s.setTokenBudget(1000.2);
      expect(store.getState().tokenBudget).toBe(1000);
    });
  });

  describe('setLastActiveTab', () => {
    it('sets the last active tab', () => {
      const store = makeStore();
      const s = store.getState();

      s.setLastActiveTab('files');
      expect(store.getState().lastActiveTab).toBe('files');

      s.setLastActiveTab('settings');
      expect(store.getState().lastActiveTab).toBe('settings');
    });

    it('accepts empty string as tab value', () => {
      const store = makeStore();
      const s = store.getState();

      s.setLastActiveTab('');
      expect(store.getState().lastActiveTab).toBe('');
    });
  });

  describe('setViewFilterPresetId', () => {
    it('sets viewFilterPresetId globally when no currentFolderId', () => {
      const store = makeStore();
      const s = store.getState();

      // Ensure no currentFolderId
      expect(store.getState().currentFolderId).toBeNull();

      s.setViewFilterPresetId('preset-1');
      expect(store.getState().viewFilterPresetId).toBe('preset-1');
    });

    it('sets viewFilterPresetId to null', () => {
      const store = makeStore();
      const s = store.getState();

      s.setViewFilterPresetId('preset-1');
      expect(store.getState().viewFilterPresetId).toBe('preset-1');

      s.setViewFilterPresetId(null);
      expect(store.getState().viewFilterPresetId).toBeNull();
    });

    it('persists viewFilterPresetId to folder state when currentFolderId exists', () => {
      const store = makeStore();
      const s = store.getState();

      s.setCurrentFolderId('root');
      s.setViewFilterPresetId('preset-2');

      expect(store.getState().viewFilterPresetId).toBe('preset-2');
      expect(store.getState().folderStates['root']?.viewFilterPresetId).toBe('preset-2');
    });

    it('sets viewFilterPresetId when currentFolderId has no folderState', () => {
      const store = makeStore();

      // Manually set a currentFolderId without creating folderState
      store.setState({ currentFolderId: 'nonexistent-folder' });

      store.getState().setViewFilterPresetId('preset-3');
      expect(store.getState().viewFilterPresetId).toBe('preset-3');
      // No folderState should be created for nonexistent folder
      expect(store.getState().folderStates['nonexistent-folder']).toBeUndefined();
    });
  });

  describe('clearDisabledFilters', () => {
    it('re-enables every disabled include and exclude filter', () => {
      // Applying a view-filter preset replaces the filter LISTS; stale
      // per-entry disable toggles must not silently survive into the new
      // preset (spike B9) — the effective filters must equal the preset.
      const store = makeStore();
      const s = store.getState();

      s.toggleFilterEnabled('*.ts', 'include');
      s.toggleFilterEnabled('node_modules', 'exclude');
      expect(store.getState().disabledIncludeFilters.size).toBe(1);
      expect(store.getState().disabledExcludeFilters.size).toBe(1);

      store.getState().clearDisabledFilters();

      expect(store.getState().disabledIncludeFilters.size).toBe(0);
      expect(store.getState().disabledExcludeFilters.size).toBe(0);
    });
  });

  describe('toggleFilterEnabled', () => {
    it('disables an include filter', () => {
      const store = makeStore();
      const s = store.getState();

      // Initially no disabled filters
      expect(store.getState().disabledIncludeFilters.size).toBe(0);

      s.toggleFilterEnabled('*.ts', 'include');
      expect(store.getState().disabledIncludeFilters.has('*.ts')).toBe(true);
    });

    it('re-enables a disabled include filter', () => {
      const store = makeStore();
      const s = store.getState();

      // Disable first
      s.toggleFilterEnabled('*.ts', 'include');
      expect(store.getState().disabledIncludeFilters.has('*.ts')).toBe(true);

      // Toggle again to re-enable
      s.toggleFilterEnabled('*.ts', 'include');
      expect(store.getState().disabledIncludeFilters.has('*.ts')).toBe(false);
    });

    it('disables an exclude filter', () => {
      const store = makeStore();
      const s = store.getState();

      // Initially no disabled filters
      expect(store.getState().disabledExcludeFilters.size).toBe(0);

      s.toggleFilterEnabled('node_modules/**', 'exclude');
      expect(store.getState().disabledExcludeFilters.has('node_modules/**')).toBe(true);
    });

    it('re-enables a disabled exclude filter', () => {
      const store = makeStore();
      const s = store.getState();

      // Disable first
      s.toggleFilterEnabled('node_modules/**', 'exclude');
      expect(store.getState().disabledExcludeFilters.has('node_modules/**')).toBe(true);

      // Toggle again to re-enable
      s.toggleFilterEnabled('node_modules/**', 'exclude');
      expect(store.getState().disabledExcludeFilters.has('node_modules/**')).toBe(false);
    });

    it('handles multiple filters independently', () => {
      const store = makeStore();
      const s = store.getState();

      s.toggleFilterEnabled('*.ts', 'include');
      s.toggleFilterEnabled('*.js', 'include');
      s.toggleFilterEnabled('node_modules/**', 'exclude');

      expect(store.getState().disabledIncludeFilters.size).toBe(2);
      expect(store.getState().disabledIncludeFilters.has('*.ts')).toBe(true);
      expect(store.getState().disabledIncludeFilters.has('*.js')).toBe(true);
      expect(store.getState().disabledExcludeFilters.size).toBe(1);
      expect(store.getState().disabledExcludeFilters.has('node_modules/**')).toBe(true);
    });
  });
});
