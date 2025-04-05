import { useFileExplorerStore } from '@/stores/__mocks__/use-file-explorer-store';

export const resetStore = () => {
  const store = useFileExplorerStore.getState();
  const mockFns = [
    'setSelectedFiles',
    'addSelectedFile',
    'removeSelectedFile',
    'clearSelectedFiles',
    'setExpandedPaths',
    'toggleDirectoryExpansion',
    'setFilters',
    'setUseRegex',
    'setIncludeProjectTree',
    'setFolderSummaryThreshold',
  ] as const;

  for (const fn of mockFns) {
    if (store[fn] && typeof store[fn] === 'function') {
      (store[fn] as jest.Mock).mockClear();
    }
  }

  useFileExplorerStore.setState({
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 100,
  });
};
