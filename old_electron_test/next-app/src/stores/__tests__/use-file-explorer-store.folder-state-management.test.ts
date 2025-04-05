import { encodeFileSelection, isPathSelectedInFolder } from '@/utils/file-selection-utils';
import { useFileExplorerStore } from '../use-file-explorer-store';

describe('folder state management', () => {
  let currentTime = 1000;

  beforeAll(() => {
    // Spy on Date.now so we can increment time easily
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterAll(() => {
    // Restore the original Date.now
    (Date.now as jest.Mock).mockRestore();
  });

  beforeEach(() => {
    // Reset time to 1000 for each test, we can increment in tests
    currentTime = 1000;

    // Reset store with custom actions so that setCurrentFolderId etc. is defined
    useFileExplorerStore.setState({
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set(),
      expandedDirectoryPaths: new Set(),
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: true,
      folderSummaryThreshold: 100,
      maxSelectionCount: 100,
      lastActiveTab: undefined,

      setCurrentFolderId: (folderId: string | null) => {
        useFileExplorerStore.setState((state) => {
          // we'll increment time if a test wants to do so
          const now = Date.now();

          // Save current folder state if it exists
          if (state.currentFolderId) {
            state.folderStates[state.currentFolderId] = {
              selectedFilePaths: state.selectedFilePaths,
              expandedDirectoryPaths: state.expandedDirectoryPaths,
              includeFilters: state.includeFilters,
              excludeFilters: state.excludeFilters,
              useRegex: state.useRegex,
              includeProjectTree: state.includeProjectTree,
              folderSummaryThreshold: state.folderSummaryThreshold,
              maxSelectionCount: state.maxSelectionCount,
              lastActiveTab: state.lastActiveTab,
              lastAccessed: now,
            };
          }

          if (!folderId) {
            return {
              ...state,
              currentFolderId: null,
              selectedFilePaths: new Set<string>(),
              expandedDirectoryPaths: new Set<string>(),
              includeFilters: [],
              excludeFilters: [],
              useRegex: false,
              includeProjectTree: true,
              folderSummaryThreshold: 100,
              maxSelectionCount: 100,
              lastActiveTab: undefined,
            };
          }

          // Cleanup old folder states if we exceed the maximum (20)
          const folderEntries = Object.entries(state.folderStates);
          if (folderEntries.length >= 20) {
            // Sort by lastAccessed (oldest first)
            folderEntries.sort(([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
            // Remove oldest entries until we are under the limit
            const entriesToRemove = folderEntries.length - 20 + 1;
            for (let i = 0; i < entriesToRemove; i++) {
              const [oldestFolderId] = folderEntries[i];
              delete state.folderStates[oldestFolderId];
            }
          }

          const existing = state.folderStates[folderId];
          if (!existing) {
            // Create new folder state with current selections
            state.folderStates[folderId] = {
              selectedFilePaths: state.selectedFilePaths,
              expandedDirectoryPaths: state.expandedDirectoryPaths,
              includeFilters: state.includeFilters,
              excludeFilters: state.excludeFilters,
              useRegex: state.useRegex,
              includeProjectTree: state.includeProjectTree,
              folderSummaryThreshold: state.folderSummaryThreshold,
              maxSelectionCount: state.maxSelectionCount,
              lastActiveTab: state.lastActiveTab,
              lastAccessed: now,
            };
            return {
              ...state,
              currentFolderId: folderId,
            };
          }

          // Update lastAccessed for existing folder state
          existing.lastAccessed = now;
          return {
            ...state,
            currentFolderId: folderId,
            selectedFilePaths: new Set(existing.selectedFilePaths),
            expandedDirectoryPaths: new Set(existing.expandedDirectoryPaths),
            includeFilters: existing.includeFilters,
            excludeFilters: existing.excludeFilters,
            useRegex: existing.useRegex,
            includeProjectTree: existing.includeProjectTree,
            folderSummaryThreshold: existing.folderSummaryThreshold,
            maxSelectionCount: existing.maxSelectionCount,
            lastActiveTab: existing.lastActiveTab,
          };
        });
      },

      addSelectedFile: (folderId: string, path: string) => {
        useFileExplorerStore.setState((state) => {
          const compositeKey = encodeFileSelection(folderId, path);
          const newSet = new Set(state.selectedFilePaths);
          newSet.add(compositeKey);
          return { selectedFilePaths: newSet };
        });
      },

      removeSelectedFile: (folderId: string, path: string) => {
        useFileExplorerStore.setState((state) => {
          const compositeKey = encodeFileSelection(folderId, path);
          const newSet = new Set(state.selectedFilePaths);
          newSet.delete(compositeKey);
          return { selectedFilePaths: newSet };
        });
      },

      toggleDirectoryExpansion: (path: string) => {
        useFileExplorerStore.setState((state) => {
          const newSet = new Set(state.expandedDirectoryPaths);
          if (newSet.has(path)) {
            newSet.delete(path);
          } else {
            newSet.add(path);
          }
          return { expandedDirectoryPaths: newSet };
        });
      },

      setFilters: (include: readonly string[], exclude: readonly string[]) => {
        useFileExplorerStore.setState({
          includeFilters: [...include],
          excludeFilters: [...exclude],
        });
      },

      setUseRegex: (useRegex: boolean) => {
        useFileExplorerStore.setState({ useRegex });
      },

      setIncludeProjectTree: (value: boolean) => {
        useFileExplorerStore.setState({ includeProjectTree: value });
      },

      setFolderSummaryThreshold: (value: number) => {
        useFileExplorerStore.setState({ folderSummaryThreshold: value });
      },

      setLastActiveTab: (tab: string) => {
        useFileExplorerStore.setState({ lastActiveTab: tab });
      },

      // No-ops (some we don't need but let's define placeholders)
      clearSelectedFiles: () => {},
      toggleSelectedFile: () => {},
      hydrateFolderState: () => {},
      setSelectedFiles: () => {},
      setExpandedPaths: () => {},
      setMaxSelectionCount: () => {},
    });
  });

  it('maintains LRU order and cleans up old folder states', () => {
    // We can now increment time manually
    for (let i = 0; i < 25; i++) {
      useFileExplorerStore.getState().setCurrentFolderId(`folder${i}`);
      currentTime++;
    }

    const state = useFileExplorerStore.getState();
    const folderStates = Object.keys(state.folderStates);

    // Should only keep 20
    expect(folderStates.length).toBeLessThanOrEqual(20);
    // The oldest folders (0-4) removed
    expect(folderStates).not.toContain('folder0');
    expect(folderStates).not.toContain('folder4');
    // The newest folders (20-24) are present
    expect(folderStates).toContain('folder20');
    expect(folderStates).toContain('folder24');
  });

  it('updates lastAccessed when revisiting a folder', () => {
    // first time set folder1
    useFileExplorerStore.getState().setCurrentFolderId('folder1');
    currentTime++;
    // switch to folder2
    useFileExplorerStore.getState().setCurrentFolderId('folder2');
    currentTime++;
    // revisit folder1
    useFileExplorerStore.getState().setCurrentFolderId('folder1');

    const finalState = useFileExplorerStore.getState().folderStates;
    expect(finalState.folder1.lastAccessed).toBe(1002); // last call
    expect(finalState.folder2.lastAccessed).toBe(1002);
  });

  it('updates lastAccessed with distinct exit and entry times', () => {
    // initial folder1
    useFileExplorerStore.getState().setCurrentFolderId('folder1');
    expect(useFileExplorerStore.getState().folderStates.folder1.lastAccessed).toBe(1000);

    currentTime++;
    // switch to folder2
    useFileExplorerStore.getState().setCurrentFolderId('folder2');
    expect(useFileExplorerStore.getState().folderStates.folder1.lastAccessed).toBe(1001);
    expect(useFileExplorerStore.getState().folderStates.folder2.lastAccessed).toBe(1001);

    currentTime++;
    // switch back to folder1
    useFileExplorerStore.getState().setCurrentFolderId('folder1');
    expect(useFileExplorerStore.getState().folderStates.folder2.lastAccessed).toBe(1002);
    expect(useFileExplorerStore.getState().folderStates.folder1.lastAccessed).toBe(1002);
  });

  it('handles exactly MAX_FOLDER_STATES folders correctly', () => {
    // Add 20
    for (let i = 0; i < 20; i++) {
      useFileExplorerStore.getState().setCurrentFolderId(`folder${i}`);
      currentTime++;
    }
    expect(Object.keys(useFileExplorerStore.getState().folderStates).length).toBe(20);

    // Add one more
    useFileExplorerStore.getState().setCurrentFolderId('folderNew');
    const finalStates = useFileExplorerStore.getState().folderStates;
    expect(Object.keys(finalStates).length).toBe(20);
    expect(finalStates.folder0).toBeUndefined();
    expect(finalStates.folderNew).toBeDefined();
  });

  it('hydrates folder state correctly', () => {
    // Reset store to empty
    useFileExplorerStore.setState({
      ...useFileExplorerStore.getState(),
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set(),
      expandedDirectoryPaths: new Set(),
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: true,
      folderSummaryThreshold: 100,
      maxSelectionCount: 100,
    });

    const folderId = 'test-folder';
    // set initial
    useFileExplorerStore.getState().setCurrentFolderId(folderId);
    useFileExplorerStore.getState().addSelectedFile(folderId, 'test.ts');
    useFileExplorerStore.getState().toggleDirectoryExpansion('src');
    useFileExplorerStore.getState().setFilters(['*.ts'], ['node_modules']);
    useFileExplorerStore.getState().setUseRegex(true);

    // Manually store data
    const compositeKey = encodeFileSelection(folderId, 'test.ts');
    const savedState = {
      selectedFilePaths: new Set([compositeKey]),
      expandedDirectoryPaths: new Set(['src']),
      includeFilters: ['*.ts'],
      excludeFilters: ['node_modules'],
      useRegex: true,
      includeProjectTree: true,
      folderSummaryThreshold: 100,
      maxSelectionCount: 100,
      lastActiveTab: undefined,
      lastAccessed: Date.now(),
    };

    useFileExplorerStore.setState((st) => ({
      ...st,
      folderStates: {
        [folderId]: savedState,
      },
    }));

    // switch away
    useFileExplorerStore.getState().setCurrentFolderId('other-folder');
    // switch back
    useFileExplorerStore.getState().setCurrentFolderId(folderId);

    const finalState = useFileExplorerStore.getState();
    expect(isPathSelectedInFolder(finalState.selectedFilePaths, folderId, 'test.ts')).toBe(true);
    expect(finalState.expandedDirectoryPaths.has('src')).toBe(true);
    expect(finalState.includeFilters).toEqual(['*.ts']);
    expect(finalState.excludeFilters).toEqual(['node_modules']);
    expect(finalState.useRegex).toBe(true);
  });

  it('saves folder state when switching folders', () => {
    const folder1 = 'folder1';
    const folder2 = 'folder2';

    useFileExplorerStore.getState().setCurrentFolderId(folder1);
    useFileExplorerStore.getState().addSelectedFile(folder1, 'test.ts');
    useFileExplorerStore.getState().toggleDirectoryExpansion('src');
    useFileExplorerStore.getState().setFilters(['*.ts'], ['node_modules']);
    useFileExplorerStore.getState().setUseRegex(true);
    useFileExplorerStore.getState().setIncludeProjectTree(false);
    useFileExplorerStore.getState().setFolderSummaryThreshold(50);
    // no maxSelectionCount method here, but that's OK
    useFileExplorerStore.getState().setLastActiveTab('preview');

    useFileExplorerStore.getState().setCurrentFolderId(folder2);

    const folder1State = useFileExplorerStore.getState().folderStates[folder1];
    expect(folder1State).toBeDefined();
    expect(isPathSelectedInFolder(folder1State.selectedFilePaths, folder1, 'test.ts')).toBe(true);
    expect(folder1State.expandedDirectoryPaths.has('src')).toBe(true);
    expect(folder1State.includeFilters).toEqual(['*.ts']);
    expect(folder1State.excludeFilters).toEqual(['node_modules']);
    expect(folder1State.useRegex).toBe(true);
    expect(folder1State.includeProjectTree).toBe(false);
    expect(folder1State.folderSummaryThreshold).toBe(50);
    expect(folder1State.lastActiveTab).toBe('preview');
  });

  it('handles folder state cleanup', () => {
    for (let i = 0; i <= 20; i++) {
      useFileExplorerStore.getState().setCurrentFolderId(`folder${i}`);
      useFileExplorerStore.getState().addSelectedFile(`folder${i}`, 'test.ts');
      currentTime++;
    }

    const store = useFileExplorerStore.getState();
    expect(store.folderStates.folder0).toBeUndefined();
    expect(Object.keys(store.folderStates).length).toBe(20);
  });
});
