import type { FileExplorerState, FolderState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderStateActions } from '../folder-state-actions';

// Create a mock state with stubbed actions
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
  fileContents: {},
  folderAccessOrder: [],
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
  ...overrides,
});

describe('folder-state-actions hydrateFolderState', () => {
  const mockSet = vi.fn();
  const mockGet = vi.fn();

  beforeEach(() => {
    mockSet.mockClear();
    mockGet.mockReset();
  });

  it('should hydrate existing folder state', () => {
    const folderState: FolderState = {
      selectedFilePaths: new Set(['a']),
      expandedDirectoryPaths: new Set(['dir']),
      includeFilters: ['*.ts'],
      excludeFilters: ['node_modules'],
      useRegex: true,
      includeProjectTree: false,
      folderSummaryThreshold: 5,
      maxSelectionCount: 10,
      lastActiveTab: 'settings',
      lastAccessed: Date.now(),
      viewFilterPresetId: null,
    };
    const state = createMockState({ folderStates: { foo: folderState } });
    const actions = createFolderStateActions(mockSet, mockGet);

    actions.hydrateFolderState('foo');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    expect(updated.selectedFilePaths).toEqual(new Set(['a']));
    expect(updated.expandedDirectoryPaths).toEqual(new Set(['dir']));
    // WORKSPACE-GLOBAL settings (view filters, useRegex, viewFilterPresetId,
    // maxSelectionCount) must be ABSENT from the hydration partial — stale
    // per-folder snapshots would silently revert the user's workspace values.
    expect(updated.includeFilters).toBeUndefined();
    expect(updated.excludeFilters).toBeUndefined();
    expect(updated.useRegex).toBeUndefined();
    expect(updated.viewFilterPresetId).toBeUndefined();
    expect(updated.maxSelectionCount).toBeUndefined();
    expect(updated.includeProjectTree).toBe(false);
    expect(updated.folderSummaryThreshold).toBe(5);
    expect(updated.lastActiveTab).toBe('settings');
  });

  it('should do nothing when folder id does not exist', () => {
    const state = createMockState({ folderStates: {} });
    const actions = createFolderStateActions(mockSet, mockGet);

    actions.hydrateFolderState('missing');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const updateFn = mockSet.mock.calls[0]?.[0] as (
      s: FileExplorerState
    ) => Partial<FileExplorerState>;
    const updated = updateFn(state);
    expect(updated).toEqual({});
  });
});
