import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { vi } from 'vitest';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  };
});

vi.mock('@brainstrike/utils/selection-utils', () => ({
  encodeFileSelection: (folderId: string, path: string) => `${folderId}|@|${path}`,
}));

export const mockSet = vi.fn();
export const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

export const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
  currentFolderId: 'folder1',
  folderStates: {},
  selectedFilePaths: new Set<string>(),
  selectionVersion: 0,
  selectionModel: createEmptySelectionModel(),
  querySelectionManifest: null,
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
  addMultipleSelectedFilesChunked: vi.fn(),
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
