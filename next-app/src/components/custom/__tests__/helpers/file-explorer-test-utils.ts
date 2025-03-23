import type { IFileNode } from '@/lib/file/types';
import { act } from '@testing-library/react';

/**
 * Mock store interface
 * Typical usage: replicate Zustand store shape for useFileExplorerStore.
 */
export interface MockStore {
  selectedFilePaths: Set<string>;
  setSelectedFiles: jest.Mock<void, [Set<string>]>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  setFilters: jest.Mock<void, [readonly string[], readonly string[]]>;
  currentFolderId: string | null;
  setCurrentFolderId: jest.Mock<void, [string | null]>;
  expandedDirectoryPaths: Set<string>;
  toggleDirectoryExpansion: jest.Mock<void, [string]>;
  addSelectedFile: jest.Mock<void, [string]>;
  removeSelectedFile: jest.Mock<void, [string]>;
  clearSelectedFiles: jest.Mock<void, []>;
}

export const defaultMockStore: MockStore = {
  selectedFilePaths: new Set<string>(),
  setSelectedFiles: jest.fn(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  maxSelectionCount: 10,
  setFilters: jest.fn(),
  currentFolderId: null,
  setCurrentFolderId: jest.fn(),
  expandedDirectoryPaths: new Set<string>(),
  toggleDirectoryExpansion: jest.fn(),
  addSelectedFile: jest.fn(),
  removeSelectedFile: jest.fn(),
  clearSelectedFiles: jest.fn(),
};

/**
 * Basic mock for useFileExplorer
 */
export const mockFileExplorer = {
  fileTree: [] as IFileNode[],
  loadFileContent: jest.fn(),
  fileContents: {} as Record<string, string>,
  error: null as Error | null,
  isLoading: false,
  isInitialLoad: false,
  rootDirectoryHandle: null as FileSystemDirectoryHandle | null,
  handleRootDirectorySelect: jest.fn(),
  isFileSystemAccessSupported: jest.fn(() => ({ supported: true, reason: '' })),
  refreshFileExplorer: jest.fn(),
  applyFileFilters: jest.fn(),
  filterError: null as string | null,
  onDisplayedFilePathsChange: jest.fn(),
};

/**
 * Basic mock for useQuickFilter
 */
export const mockQuickFilter = {
  quickFilter: '',
  setQuickFilter: jest.fn(),
  filteredTree: [] as IFileNode[],
  clearFilter: jest.fn(),
};

/**
 * Basic mock for useFileSystem
 */
export const mockFileSystem = {
  selectRootDirectory: jest.fn(),
  isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
};

/**
 * Basic mock for useFileExplorerSettings
 */
export const mockSettings = {
  settings: {
    maxSelectionCount: 10,
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 3,
  },
  updateSettings: jest.fn(),
};

/**
 * Basic mock for useReportGeneration
 */
export const mockReportGeneration = {
  generateReportWithContent: jest.fn().mockResolvedValue('Mock Report Content'),
  isGenerating: false,
};

/**
 * Resets the mock store to default + clears jest mocks
 * so each test starts fresh.
 */
export function resetDefaultMockStore(store: MockStore) {
  act(() => {
    store.selectedFilePaths.clear();
    store.includeFilters = [];
    store.excludeFilters = [];
    store.useRegex = false;
    store.maxSelectionCount = 10;
    store.currentFolderId = null;
    store.expandedDirectoryPaths.clear();
  });
  // Clear all jest mock calls
  for (const key of Object.keys(store) as Array<keyof MockStore>) {
    const value = store[key];
    if (typeof value === 'function' && 'mockClear' in value) {
      value.mockClear();
    }
  }
}

/**
 * Helper for a directory handle
 */
export function createMockDirectoryHandle(): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'mock-dir',
    getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
    getFileHandle: async () => ({}) as FileSystemFileHandle,
    removeEntry: async () => {},
    resolve: async () => [],
    entries: async function* () {},
    isSameEntry: async () => true,
  };
}
