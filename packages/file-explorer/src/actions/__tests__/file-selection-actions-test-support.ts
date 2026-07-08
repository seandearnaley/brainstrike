import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { vi } from 'vitest';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    }),
  };
});

vi.mock('@brainstrike/utils/selection-utils', () => ({
  encodeFileSelection: (folderId: string, path: string) => `${folderId}|@|${path}`,
}));

export const mockSet = vi.fn();
export const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

export const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
  addMultipleSelectedFiles: vi.fn(),
  addMultipleSelectedFilesChunked: vi.fn(),
  addSelectedFile: vi.fn(),
  clearAllFileContents: vi.fn(),
  clearFileContents: vi.fn(),
  clearSelectedFiles: vi.fn(),
  collapseAllDirectories: vi.fn(),
  currentFolderId: 'folder1',
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
  querySelectionManifest: null,
  removeMultipleSelectedFiles: vi.fn(),
  removeSelectedFile: vi.fn(),
  selectedFilePaths: new Set<string>(),
  selectionModel: createEmptySelectionModel(),
  selectionVersion: 0,
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
