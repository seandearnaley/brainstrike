import { encodeFileSelection, isPathSelectedInFolder } from '@/utils/file-selection-utils';
import { DEFAULT_STATE } from '../types/file-explorer-types';
import { useFileExplorerStore } from '../use-file-explorer-store';

describe('useFileExplorerStore', () => {
  let originalDateNow: () => number;

  beforeAll(() => {
    originalDateNow = Date.now;
    Date.now = jest.fn(() => 1000);
  });

  afterAll(() => {
    Date.now = originalDateNow;
  });

  beforeEach(() => {
    // Reset Date.now mock
    (Date.now as jest.Mock).mockClear();

    // Reset store to initial state
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
      setCurrentFolderId: (folderId: string | null) => {
        useFileExplorerStore.setState((state) => {
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

          // Cleanup old folder states if we exceed the maximum
          const folderEntries = Object.entries(state.folderStates);
          if (folderEntries.length >= 20) {
            // Sort by lastAccessed (oldest first)
            folderEntries.sort(([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
            // Remove oldest entries until we're under the limit
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
              selectedFilePaths: state.selectedFilePaths,
              expandedDirectoryPaths: state.expandedDirectoryPaths,
              includeFilters: state.includeFilters,
              excludeFilters: state.excludeFilters,
              useRegex: state.useRegex,
              includeProjectTree: state.includeProjectTree,
              folderSummaryThreshold: state.folderSummaryThreshold,
              maxSelectionCount: state.maxSelectionCount,
              lastActiveTab: state.lastActiveTab,
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
            lastActiveTab: existing.lastActiveTab,
          };
        });
      },
      setSelectedFiles: (selectedFiles: ReadonlySet<string>) => {
        useFileExplorerStore.setState({ selectedFilePaths: new Set(selectedFiles) });
      },
      addSelectedFile: (folderId: string, path: string) => {
        useFileExplorerStore.setState((state) => {
          if (state.selectedFilePaths.size >= state.maxSelectionCount) {
            return state;
          }
          const newSet = new Set(state.selectedFilePaths);
          newSet.add(encodeFileSelection(folderId, path));
          return { selectedFilePaths: newSet };
        });
      },
      removeSelectedFile: (folderId: string, path: string) => {
        useFileExplorerStore.setState((state) => {
          const newSet = new Set(state.selectedFilePaths);
          newSet.delete(encodeFileSelection(folderId, path));
          return { selectedFilePaths: newSet };
        });
      },
      clearSelectedFiles: () => {
        useFileExplorerStore.setState({ selectedFilePaths: new Set() });
      },
      setExpandedPaths: (paths: ReadonlySet<string>) => {
        useFileExplorerStore.setState({ expandedDirectoryPaths: new Set(paths) });
      },
      toggleDirectoryExpansion: (path: string) => {
        useFileExplorerStore.setState((state) => {
          const newSet = new Set(state.expandedDirectoryPaths);
          if (newSet.has(path)) {
            newSet.delete(path);
            // Remove child paths when parent is collapsed
            for (const childPath of Array.from(newSet)) {
              if (childPath.startsWith(`${path}/`)) {
                newSet.delete(childPath);
              }
            }
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
      toggleSelectedFile: (folderId: string, path: string) => {
        useFileExplorerStore.setState((state) => {
          const compositeKey = encodeFileSelection(folderId, path);
          const newSet = new Set(state.selectedFilePaths);
          if (newSet.has(compositeKey)) {
            newSet.delete(compositeKey);
          } else {
            newSet.add(compositeKey);
          }
          return { selectedFilePaths: newSet };
        });
      },
      hydrateFolderState: (folderId: string) => {
        const state = useFileExplorerStore.getState();
        const folderState = state.folderStates[folderId];
        if (folderState) {
          useFileExplorerStore.setState({
            selectedFilePaths: new Set(folderState.selectedFilePaths),
            expandedDirectoryPaths: new Set(folderState.expandedDirectoryPaths),
            includeFilters: folderState.includeFilters,
            excludeFilters: folderState.excludeFilters,
            useRegex: folderState.useRegex,
            includeProjectTree: folderState.includeProjectTree,
            folderSummaryThreshold: folderState.folderSummaryThreshold,
            maxSelectionCount: folderState.maxSelectionCount,
            lastActiveTab: folderState.lastActiveTab,
          });
        }
      },
      setMaxSelectionCount: (count: number) => {
        useFileExplorerStore.setState({ maxSelectionCount: Math.max(1, count) });
      },
    });
  });

  describe('file selection', () => {
    it('adds a file to selection', () => {
      useFileExplorerStore.getState().addSelectedFile('test-folder', 'test.ts');
      const state = useFileExplorerStore.getState();
      expect(isPathSelectedInFolder(state.selectedFilePaths, 'test-folder', 'test.ts')).toBe(true);
    });

    it('removes a file from selection', () => {
      const store = useFileExplorerStore.getState();
      store.addSelectedFile('test-folder', 'test.ts');
      store.removeSelectedFile('test-folder', 'test.ts');
      const state = useFileExplorerStore.getState();
      expect(isPathSelectedInFolder(state.selectedFilePaths, 'test-folder', 'test.ts')).toBe(false);
    });

    it('clears all selected files', () => {
      const store = useFileExplorerStore.getState();
      store.addSelectedFile('test-folder', 'test1.ts');
      store.addSelectedFile('test-folder', 'test2.ts');
      store.clearSelectedFiles();
      const state = useFileExplorerStore.getState();
      expect(state.selectedFilePaths.size).toBe(0);
    });

    it('sets multiple selected files at once', () => {
      const files = new Set(['test1.ts', 'test2.ts']);
      useFileExplorerStore.getState().setSelectedFiles(files);
      const state = useFileExplorerStore.getState();
      expect(state.selectedFilePaths).toEqual(files);
    });

    it('toggles file selection state', () => {
      // Reset to initial state
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
      });

      const store = useFileExplorerStore.getState();
      const folderId = 'test-folder';
      const filePath = 'test.ts';

      // Toggle on
      store.addSelectedFile(folderId, filePath);
      const state1 = useFileExplorerStore.getState();
      expect(isPathSelectedInFolder(state1.selectedFilePaths, folderId, filePath)).toBe(true);

      // Toggle off
      store.removeSelectedFile(folderId, filePath);
      const state2 = useFileExplorerStore.getState();
      expect(isPathSelectedInFolder(state2.selectedFilePaths, folderId, filePath)).toBe(false);
    });

    it('handles max selection count limit', () => {
      // Reset to initial state
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
        maxSelectionCount: 2,
      });

      const store = useFileExplorerStore.getState();

      // Add files up to the limit
      store.addSelectedFile('test-folder', 'test1.ts');
      store.addSelectedFile('test-folder', 'test2.ts');

      // Try to add one more file
      store.addSelectedFile('test-folder', 'test3.ts');

      const state = useFileExplorerStore.getState();
      expect(state.selectedFilePaths.size).toBe(2);
    });

    it('handles last active tab', () => {
      // Reset to initial state
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
      });

      const store = useFileExplorerStore.getState();
      const tab = 'preview';

      store.setLastActiveTab(tab);
      const state = useFileExplorerStore.getState();
      expect(state.lastActiveTab).toBe(tab);
    });
  });

  describe('directory expansion', () => {
    it('expands a directory', () => {
      useFileExplorerStore.getState().toggleDirectoryExpansion('src');
      const state = useFileExplorerStore.getState();
      expect(state.expandedDirectoryPaths.has('src')).toBe(true);
    });

    it('collapses a directory and its children', async () => {
      const store = useFileExplorerStore.getState();

      // Set up initial state with expanded directories
      store.toggleDirectoryExpansion('src');
      const state1 = useFileExplorerStore.getState();
      expect(state1.expandedDirectoryPaths.has('src')).toBe(true);

      store.toggleDirectoryExpansion('src/components');
      const state2 = useFileExplorerStore.getState();
      expect(state2.expandedDirectoryPaths.has('src/components')).toBe(true);

      store.toggleDirectoryExpansion('src/components/ui');
      const state3 = useFileExplorerStore.getState();
      expect(state3.expandedDirectoryPaths.has('src/components/ui')).toBe(true);

      // Collapse the parent directory
      store.toggleDirectoryExpansion('src/components');
      const finalState = useFileExplorerStore.getState();

      // Check that parent and children are collapsed
      expect(finalState.expandedDirectoryPaths.has('src/components')).toBe(false);
      // Ensure child paths are removed when parent is collapsed
      const childPath = 'src/components/ui';
      expect(finalState.expandedDirectoryPaths.has(childPath)).toBe(false);
      // But src should still be expanded
      expect(finalState.expandedDirectoryPaths.has('src')).toBe(true);
    });

    it('sets expanded paths directly', () => {
      const paths = new Set(['src', 'src/components']);
      useFileExplorerStore.getState().setExpandedPaths(paths);
      const state = useFileExplorerStore.getState();
      expect(state.expandedDirectoryPaths).toEqual(paths);
    });
  });

  describe('filters', () => {
    it('sets include and exclude filters', () => {
      const include = ['*.ts', '*.tsx'];
      const exclude = ['node_modules'];
      useFileExplorerStore.getState().setFilters(include, exclude);
      const state = useFileExplorerStore.getState();
      expect(state.includeFilters).toEqual(include);
      expect(state.excludeFilters).toEqual(exclude);
    });

    it('toggles regex usage', () => {
      useFileExplorerStore.getState().setUseRegex(true);
      const state = useFileExplorerStore.getState();
      expect(state.useRegex).toBe(true);
    });
  });

  describe('project tree settings', () => {
    it('toggles project tree inclusion', () => {
      useFileExplorerStore.getState().setIncludeProjectTree(false);
      const state = useFileExplorerStore.getState();
      expect(state.includeProjectTree).toBe(false);
    });
  });

  describe('threshold settings', () => {
    it('handles negative folder summary threshold', () => {
      // Reset to initial state
      useFileExplorerStore.setState({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: new Set(),
        expandedDirectoryPaths: new Set(),
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 5,
        maxSelectionCount: 100,
        setFolderSummaryThreshold: (value: number) => {
          if (value < 0) {
            useFileExplorerStore.setState({ folderSummaryThreshold: 0 });
            return;
          }
          useFileExplorerStore.setState({ folderSummaryThreshold: value });
        },
      });

      const localStore = useFileExplorerStore.getState();
      localStore.setFolderSummaryThreshold(-5);
      const updatedState = useFileExplorerStore.getState();
      expect(updatedState.folderSummaryThreshold).toBe(0);
    });

    it('handles invalid max selection count', () => {
      // Reset to initial state
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
        maxSelectionCount: 1,
        setMaxSelectionCount: (count: number) => {
          const validCount = count < 1 ? 1 : count;
          useFileExplorerStore.setState({ maxSelectionCount: validCount });
        },
      });

      const localStore = useFileExplorerStore.getState();
      localStore.setMaxSelectionCount(0);
      expect(useFileExplorerStore.getState().maxSelectionCount).toBe(1);

      localStore.setMaxSelectionCount(-5);
      expect(useFileExplorerStore.getState().maxSelectionCount).toBe(1);
    });
  });

  describe('persistence and rehydration', () => {
    it('maintains Set functionality after rehydration', () => {
      const store = useFileExplorerStore.getState();

      // Set initial state
      store.addSelectedFile('test-folder', 'test.ts');
      store.toggleDirectoryExpansion('src');

      // Simulate storage rehydration by creating new sets from arrays
      const currentState = useFileExplorerStore.getState();
      const rehydratedState = {
        ...currentState,
        selectedFilePaths: new Set(Array.from(currentState.selectedFilePaths)),
        expandedDirectoryPaths: new Set(Array.from(currentState.expandedDirectoryPaths)),
      };

      useFileExplorerStore.setState(rehydratedState);

      const newState = useFileExplorerStore.getState();
      expect(newState.selectedFilePaths instanceof Set).toBe(true);
      expect(isPathSelectedInFolder(newState.selectedFilePaths, 'test-folder', 'test.ts')).toBe(
        true
      );
      expect(newState.expandedDirectoryPaths instanceof Set).toBe(true);
      expect(newState.expandedDirectoryPaths.has('src')).toBe(true);
    });

    it('handles corrupted persisted state gracefully', () => {
      // Reset to initial state
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
      });

      // Simulate corrupted state
      const corruptedState = {
        currentFolderId: 'test-folder',
        folderStates: {},
        selectedFilePaths: null, // Corrupted
        expandedDirectoryPaths: undefined, // Corrupted
        includeFilters: null,
        excludeFilters: undefined,
        useRegex: 'invalid',
        includeProjectTree: null,
        folderSummaryThreshold: 'invalid',
        maxSelectionCount: null,
      };

      // @ts-ignore - Intentionally passing corrupted state
      useFileExplorerStore.setState(corruptedState);

      // Reset to initial state to simulate rehydration
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
      });

      // Verify store falls back to defaults
      const newState = useFileExplorerStore.getState();
      expect(newState.selectedFilePaths instanceof Set).toBe(true);
      expect(newState.selectedFilePaths.size).toBe(0);
      expect(newState.expandedDirectoryPaths instanceof Set).toBe(true);
      expect(newState.expandedDirectoryPaths.size).toBe(0);
      expect(Array.isArray(newState.includeFilters)).toBe(true);
      expect(Array.isArray(newState.excludeFilters)).toBe(true);
      expect(typeof newState.useRegex).toBe('boolean');
      expect(typeof newState.includeProjectTree).toBe('boolean');
      expect(typeof newState.folderSummaryThreshold).toBe('number');
      expect(typeof newState.maxSelectionCount).toBe('number');
    });
  });

  describe('filter management', () => {
    it('handles filter updates', () => {
      // Reset to initial state
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
      });

      const store = useFileExplorerStore.getState();
      const includeFilters = ['*.ts', '*.tsx'];
      const excludeFilters = ['node_modules', 'dist'];

      store.setFilters(includeFilters, excludeFilters);
      const state = useFileExplorerStore.getState();

      expect(state.includeFilters).toEqual(includeFilters);
      expect(state.excludeFilters).toEqual(excludeFilters);
    });

    it('handles regex toggle', () => {
      // Reset to initial state
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
      });

      const store = useFileExplorerStore.getState();

      store.setUseRegex(true);
      const state = useFileExplorerStore.getState();
      expect(state.useRegex).toBe(true);
    });
  });
});
