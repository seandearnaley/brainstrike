import type { IFileNode } from '@/lib/file/types';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Mock store interface
 * Typical usage: replicate Zustand store shape for useFileExplorerStore.
 */
interface MockStore {
  selectedFilePaths: Set<string>;
  setSelectedFiles: Mock;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  setFilters: Mock;
  currentFolderId: string | null;
  setCurrentFolderId: Mock;
  expandedDirectoryPaths: Set<string>;
  toggleDirectoryExpansion: Mock;
  addSelectedFile: Mock;
  removeSelectedFile: Mock;
  clearSelectedFiles: Mock;
}

export const defaultMockStore: MockStore = {
  selectedFilePaths: new Set<string>(),
  setSelectedFiles: vi.fn(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  maxSelectionCount: 10,
  setFilters: vi.fn(),
  currentFolderId: null,
  setCurrentFolderId: vi.fn(),
  expandedDirectoryPaths: new Set<string>(),
  toggleDirectoryExpansion: vi.fn(),
  addSelectedFile: vi.fn(),
  removeSelectedFile: vi.fn(),
  clearSelectedFiles: vi.fn(),
};

/**
 * Basic mock for useFileExplorer
 */
export const mockFileExplorer = {
  fileTree: [] as IFileNode[],
  loadFileContent: vi.fn(),
  fileContents: {} as Record<string, string>,
  error: null as Error | null,
  isLoading: false,
  isInitialLoad: false,
  rootDirectoryHandle: null as FileSystemDirectoryHandle | null,
  handleRootDirectorySelect: vi.fn(),
  isFileSystemAccessSupported: vi.fn(() => ({ supported: true, reason: '' })),
  refreshFileExplorer: vi.fn(),
  applyFileFilters: vi.fn(),
  filterError: null as string | null,
  onDisplayedFilePathsChange: vi.fn(),
};

/**
 * Basic mock for useQuickFilter
 */
export const mockQuickFilter = {
  quickFilter: '',
  setQuickFilter: vi.fn(),
  filteredTree: [] as IFileNode[],
  clearFilter: vi.fn(),
};

/**
 * Basic mock for useFileSystem
 */
export const mockFileSystem = {
  selectRootDirectory: vi.fn(),
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
  updateSettings: vi.fn(),
};

/**
 * Basic mock for useReportGeneration
 */
export const mockReportGeneration = {
  generateReportWithContent: vi.fn().mockResolvedValue('Mock Report Content'),
  isGenerating: false,
};

/**
 * Resets the mock store to default + clears jest mocks
 * so each test starts fresh.
 */
export function resetDefaultMockStore(mockStore: MockStore) {
  mockStore.selectedFilePaths = new Set<string>();
  mockStore.includeFilters = [];
  mockStore.excludeFilters = [];
  mockStore.useRegex = false;
  mockStore.maxSelectionCount = 10;
  mockStore.currentFolderId = null;
  mockStore.expandedDirectoryPaths = new Set<string>();
}

/**
 * Helper for a directory handle
 */
export function createMockDirectoryHandle(): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'test-root',
  } as unknown as FileSystemDirectoryHandle;
}
