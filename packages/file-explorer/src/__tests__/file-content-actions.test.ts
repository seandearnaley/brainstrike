import type { FileExplorerState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createFileContentActions } from '../actions/file-content-actions';

// Combine action return type for typing

// Helper to create minimal store with actions applied
function createTestStore() {
  const store = createStore<FileExplorerState>(() => ({
    ...DEFAULT_STATE,
    currentFolderId: null,
    folderStates: {},
    folderAccessOrder: [],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
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
  }));

  const actions = createFileContentActions(store.setState, store.getState);
  store.setState((state) => ({
    ...state,
    ...actions,
  }));

  return store;
}

describe('file-content-actions', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('setFileContent should update fileContents with given key and content', () => {
    store.getState().setFileContent('a|@|file.ts', 'hello');
    const state = store.getState();
    expect(state.fileContents['a|@|file.ts']).toBe('hello');
  });

  it('clearFileContents should remove specified keys', () => {
    store.setState((state) => ({
      ...state,
      fileContents: {
        key1: 'c1',
        key2: 'c2',
      },
    }));

    store.getState().clearFileContents(['key1']);
    const state = store.getState();
    expect(state.fileContents).toEqual({ key2: 'c2' });
  });

  it('clearAllFileContents should empty the map', () => {
    store.setState((state) => ({
      ...state,
      fileContents: {
        key1: 'c1',
      },
    }));

    store.getState().clearAllFileContents();
    const state = store.getState();
    expect(state.fileContents).toEqual({});
  });
});
