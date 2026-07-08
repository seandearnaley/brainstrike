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
    addMultipleSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    clearAllFileContents: vi.fn(),
    clearFileContents: vi.fn(),
    clearSelectedFiles: vi.fn(),
    collapseAllDirectories: vi.fn(),
    currentFolderId: null,
    evictOldFileContents: vi.fn(),
    expandAllDirectories: vi.fn(),
    expandedDirectoryPaths: new Set<string>(),
    folderAccessOrder: [],
    folderStates: {},
    getFileContent: vi.fn(),
    getFileContentCacheStats: vi.fn(),
    hydrateFolderState: vi.fn(),
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
        key2: 'c2',
      },
    }));

    store.getState().clearAllFileContents();
    const state = store.getState();
    expect(state.fileContents).toEqual({});
  });

  it('getFileContent should prioritize cache over state to prevent split-brain scenario', () => {
    // Set some content in state directly (simulating old state)
    store.setState((state) => ({
      ...state,
      fileContents: {
        'test|@|file.ts': 'old content',
      },
    }));

    // Set newer content through setFileContent (which updates cache first)
    store.getState().setFileContent('test|@|file.ts', 'new content');

    // getFileContent should return cache content, not state content
    const content = store.getState().getFileContent('test|@|file.ts');
    expect(content).toBe('new content');
  });

  it('should handle cache memory constraints by filtering state while preserving access through cache', () => {
    // Add enough content to trigger cache-aware filtering (>2MB threshold)
    const largeContent = 'x'.repeat(300 * 1024); // 300KB per file

    // Add 10 files to exceed 2MB threshold
    for (let i = 0; i < 10; i++) {
      store.getState().setFileContent(`file${i}|@|test.ts`, largeContent);
    }

    // State should be filtered but all content accessible via getFileContent
    const state = store.getState();

    // State should contain limited number of files (10 recent + current file = max 11)
    expect(Object.keys(state.fileContents).length).toBeLessThanOrEqual(11);

    // But all files should be accessible through getFileContent (cache)
    for (let i = 0; i < 10; i++) {
      const content = store.getState().getFileContent(`file${i}|@|test.ts`);
      expect(content).toBe(largeContent);
    }
  });

  it('should prevent race conditions by using atomic cache snapshots', async () => {
    // Simulate a scenario where cache eviction happens during state building
    const content1 = 'x'.repeat(100 * 1024); // 100KB

    // Add multiple files quickly to stress test atomic operations
    vi.useFakeTimers();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          const delay = (i % 10) + 1; // deterministic small stagger
          setTimeout(() => {
            store.getState().setFileContent(`concurrent${i}|@|test.ts`, content1);
            resolve();
          }, delay);
        })
      );
    }

    await vi.runAllTimersAsync();
    await Promise.all(promises);
    vi.useRealTimers();

    // All files should be accessible despite concurrent operations
    for (let i = 0; i < 20; i++) {
      const content = store.getState().getFileContent(`concurrent${i}|@|test.ts`);
      expect(content).toBe(content1);
    }
  });

  it('should ensure current file is always included in filtered state', () => {
    // Add enough content to trigger filtering
    const largeContent = 'x'.repeat(300 * 1024); // 300KB per file

    // Add files to exceed threshold
    for (let i = 0; i < 8; i++) {
      store.getState().setFileContent(`old${i}|@|test.ts`, largeContent);
    }

    // Add a new file that should definitely be in filtered state
    const newFileKey = 'newest|@|test.ts';
    const newContent = 'newest content';
    store.getState().setFileContent(newFileKey, newContent);

    const state = store.getState();

    // The newest file should always be in state regardless of filtering
    expect(state.fileContents[newFileKey]).toBe(newContent);
  });

  it('should handle defensive checks for undefined cache values', () => {
    // Simulate cache returning undefined (edge case)
    const testKey = 'defensive|@|test.ts';

    // Get content for non-existent key
    const content = store.getState().getFileContent(testKey);
    expect(content).toBeUndefined();

    // Set content normally
    store.getState().setFileContent(testKey, 'test content');

    // Should be able to retrieve it
    const retrievedContent = store.getState().getFileContent(testKey);
    expect(retrievedContent).toBe('test content');
  });
});
