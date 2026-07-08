import type { FileExplorerState, FolderState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderStateActions } from '../folder-state-actions';

// Create a mock state with stubbed actions
const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
  addMultipleSelectedFiles: vi.fn(),
  addSelectedFile: vi.fn(),
  clearAllFileContents: vi.fn(),
  clearFileContents: vi.fn(),
  clearSelectedFiles: vi.fn(),
  collapseAllDirectories: vi.fn(),
  currentFolderId: null,
  excludeFilters: [],
  expandAllDirectories: vi.fn(),
  expandedDirectoryPaths: new Set<string>(),
  fileContents: {},
  folderAccessOrder: [],
  folderStates: {},
  folderSummaryThreshold: 100,
  hydrateFolderState: vi.fn(),
  includeFilters: [],
  includeProjectTree: true,
  lastActiveTab: 'files',
  maxSelectionCount: 100,
  removeMultipleSelectedFiles: vi.fn(),
  removeSelectedFile: vi.fn(),
  selectedFilePaths: new Set<string>(),
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
  useRegex: false,
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
      excludeFilters: ['node_modules'],
      expandedDirectoryPaths: new Set(['dir']),
      folderSummaryThreshold: 5,
      includeFilters: ['*.ts'],
      includeProjectTree: false,
      lastAccessed: Date.now(),
      lastActiveTab: 'settings',
      maxSelectionCount: 10,
      selectedFilePaths: new Set(['a']),
      useRegex: true,
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
    // WORKSPACE-GLOBAL state (expansion, view filters, useRegex,
    // viewFilterPresetId, maxSelectionCount) must be ABSENT from the
    // hydration partial — stale per-folder snapshots would silently revert
    // the user's workspace values.
    expect(updated.expandedDirectoryPaths).toBeUndefined();
    expect(updated.includeFilters).toBeUndefined();
    expect(updated.excludeFilters).toBeUndefined();
    expect(updated.useRegex).toBeUndefined();
    expect(updated.viewFilterPresetId).toBeUndefined();
    expect(updated.maxSelectionCount).toBeUndefined();
    // Hardening B: the report/tab settings joined the doctrine too — only
    // the SELECTION is per-root.
    expect(updated.includeProjectTree).toBeUndefined();
    expect(updated.tokenBudget).toBeUndefined();
    expect(updated.folderSummaryThreshold).toBeUndefined();
    expect(updated.lastActiveTab).toBeUndefined();
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
