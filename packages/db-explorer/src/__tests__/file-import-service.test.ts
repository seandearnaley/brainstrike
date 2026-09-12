import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileImportService } from '../base-file-import-service';
import { FileImportError } from '../file-import/file-import-errors';

// Mock dependencies to avoid complex setup
const {
  mockBulkImport,
  mockReadFile,
  mockGetFileHandle,
  mockDecodeFileSelection,
  mockFindNodeByPath,
  mockGetFileExtension,
  mockIsBinaryExtension,
  mockIsTextExtension,
  mockIsTextContent,
  mockLogger,
} = vi.hoisted(() => ({
  mockBulkImport: vi.fn(),
  mockDecodeFileSelection: vi.fn(),
  mockFindNodeByPath: vi.fn(),
  mockGetFileExtension: vi.fn(),
  mockGetFileHandle: vi.fn(),
  mockIsBinaryExtension: vi.fn(),
  mockIsTextContent: vi.fn(),
  mockIsTextExtension: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  mockReadFile: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useFileChunkRepository: () => null,
  useFileRecordRepository: () => ({
    bulkImport: mockBulkImport,
  }),
  usePGliteDatabase: () => null,
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useFileChunkRepository: () => null,
  useFileRecordRepository: () => ({
    bulkImport: mockBulkImport,
  }),
  usePGliteDatabase: () => null,
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {
      getHandleCache: () => ({
        getFileHandle: mockGetFileHandle,
      }),
      readFile: mockReadFile,
    },
  }),
}));

vi.mock('@brainstrike/file-explorer/selection', () => ({
  decodeFileSelection: mockDecodeFileSelection,
}));

vi.mock('@brainstrike/utils/file-content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/utils/file-content')>()),
  fileContent: {
    isBinaryExtension: mockIsBinaryExtension,
    isTextContent: mockIsTextContent,
    isTextExtension: mockIsTextExtension,
  },
}));

vi.mock('@brainstrike/file-explorer/file-tree', () => ({
  fileExplorer: {
    findNodeByPath: mockFindNodeByPath,
    getFileExtension: mockGetFileExtension,
  },
}));

vi.mock('@brainstrike/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('useFileImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkImport.mockResolvedValue([{ existed: false, id: '1', imported: true }]);
    mockGetFileHandle.mockReset();
    mockGetFileHandle.mockResolvedValue(null);
    mockDecodeFileSelection.mockReturnValue({
      folderId: 'test-folder',
      path: '/test/path',
    });
    mockFindNodeByPath.mockReturnValue(null);
    mockGetFileExtension.mockReturnValue('txt');
    mockIsBinaryExtension.mockReturnValue(false);
    mockIsTextExtension.mockReturnValue(true);
    mockIsTextContent.mockReturnValue(true);
  });

  describe('Initialization', () => {
    it('should initialize with correct default state', () => {
      const { result } = renderHook(() => useFileImportService());

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should accept options parameter', () => {
      const options = {
        onComplete: vi.fn(),
        onError: vi.fn(),
        onProgress: vi.fn(),
      };

      const { result } = renderHook(() => useFileImportService(options));

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should handle empty options', () => {
      const { result } = renderHook(() => useFileImportService({}));

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });
  });

  describe('Import Validation', () => {
    it('should handle empty file selection', async () => {
      const onError = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onError }));

      await act(async () => {
        await result.current.importFiles(new Set(), [], {});
      });

      expect(onError).toHaveBeenCalledWith(expect.any(FileImportError));
      const error = onError.mock.calls.at(-1)?.[0] as FileImportError;
      expect(error.code).toBe('empty-selection');
      expect(error.message).toBe('No files selected for import');
    });
  });

  describe('Import with cached content', () => {
    it('should import files with cached content', async () => {
      const onComplete = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onComplete }));

      const fileContents = {
        'test-folder:/test/path': 'test file content',
      };

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], fileContents);
      });

      expect(mockBulkImport).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            content: 'test file content',
            name: 'path',
            path: '/test/path',
            size: 17,
          }),
        ],
        expect.any(Function)
      );
      expect(onComplete).toHaveBeenCalled();
    });

    it('imports cached files in bounded batches to cap retained request memory', async () => {
      const { result } = renderHook(() => useFileImportService());
      const selectedFilePaths = new Set<string>();
      const fileContents: Record<string, string> = {};

      for (let index = 0; index < 120; index += 1) {
        const compositeKey = `test-folder:/test/path-${index}.ts`;
        selectedFilePaths.add(compositeKey);
        fileContents[compositeKey] = `export const value${index} = ${index};`;
      }

      await act(async () => {
        await result.current.importFiles(selectedFilePaths, [], fileContents);
      });

      expect(mockBulkImport).toHaveBeenCalledTimes(3);
      const batchSizes = mockBulkImport.mock.calls.map((call) => (call[0] as unknown[]).length);
      expect(batchSizes).toEqual([50, 50, 20]);
    });

    it('should handle progress tracking', async () => {
      const onProgress = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onProgress }));

      const fileContents = {
        'test-folder:/test/path': 'test content',
      };

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], fileContents);
      });

      expect(onProgress).toHaveBeenCalled();
      expect(result.current.progress).toBeDefined();
    });

    it('does not double-count prior batch failures in later batch progress updates', async () => {
      const onProgress = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onProgress }));

      const selectedFilePaths = new Set<string>();
      const fileContents: Record<string, string> = {};

      for (let index = 0; index < 75; index += 1) {
        const compositeKey = `test-folder:/test/path-${index}.ts`;
        selectedFilePaths.add(compositeKey);
        fileContents[compositeKey] = `export const value${index} = ${index};`;
      }

      mockBulkImport
        .mockImplementationOnce(
          async (
            requests: Array<{
              content: string;
              embeddingSetId?: string;
              name: string;
              path: string;
              size: number;
            }>,
            onBatchProgress: (completed: number, total: number, current?: string) => void
          ) => {
            onBatchProgress(50, requests.length, 'batch-1-complete');
            return requests.map((request, index) =>
              index === 0
                ? { error: 'failed', existed: false, id: `failed-${request.name}`, imported: false }
                : { existed: false, id: `${request.name}`, imported: true }
            );
          }
        )
        .mockImplementationOnce(
          async (
            requests: Array<{
              content: string;
              embeddingSetId?: string;
              name: string;
              path: string;
              size: number;
            }>,
            onBatchProgress: (completed: number, total: number, current?: string) => void
          ) => {
            onBatchProgress(24, requests.length, 'batch-2-incomplete');
            onBatchProgress(25, requests.length, 'batch-2-complete');
            return requests.map((request) => ({
              existed: false,
              id: `${request.name}`,
              imported: true,
            }));
          }
        );

      await act(async () => {
        await result.current.importFiles(selectedFilePaths, [], fileContents);
      });

      const incompleteSecondBatchProgress = onProgress.mock.calls
        .map(([progress]) => progress as { completed: number; current?: string })
        .find((progress) => progress.current === 'batch-2-incomplete');

      expect(incompleteSecondBatchProgress).toBeDefined();
      expect(incompleteSecondBatchProgress?.completed).toBe(74);
    });
  });

  describe('Error handling', () => {
    it('should handle database errors', async () => {
      mockBulkImport.mockRejectedValue(new Error('Database error'));

      const onError = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onError }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onError).toHaveBeenCalledWith(expect.any(FileImportError));
      const error = onError.mock.calls.at(-1)?.[0] as FileImportError;
      expect(error.code).toBe('repository-error');
      expect(error.message).toBe('Database error');
    });

    it('should handle bulk import returning null', async () => {
      mockBulkImport.mockResolvedValue(null);

      const onError = vi.fn();
      const { result } = renderHook(() => useFileImportService({ onError }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onError).toHaveBeenCalledWith(expect.any(FileImportError));
      const error = onError.mock.calls.at(-1)?.[0] as FileImportError;
      expect(error.code).toBe('unsupported-operation');
      expect(error.message).toBe('Bulk import not supported by repository');
    });
  });

  describe('File tree import', () => {
    it('should import files from file tree when no cached content', async () => {
      const mockFileNode: IFileNode = {
        depth: 0,
        handle: {
          _internal: { getFile: vi.fn(), kind: 'file', name: 'test.txt' },
          kind: 'file',
          name: 'test.txt',
          path: '/canonical/test.txt',
          platform: 'web',
          rootId: 'durable-root',
        },
        name: 'test.txt',
        path: '/test/path',
        rootFolderId: 'test-folder',
        selectionState: 'unchecked',
        size: 100,
        type: 'file',
      };

      mockFindNodeByPath.mockReturnValue(mockFileNode);
      mockReadFile.mockResolvedValue('file content from disk');

      const { result } = renderHook(() => useFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [mockFileNode], {});
      });

      expect(mockReadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          _internal: 'platform' in mockFileNode.handle ? mockFileNode.handle._internal : undefined,
          path: '/canonical/test.txt',
          platform: 'web',
          rootId: 'durable-root',
        })
      );
      expect(mockBulkImport).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            content: 'file content from disk',
            name: 'test.txt',
            path: '/test/path',
            size: 100,
          }),
        ],
        expect.any(Function)
      );
    });

    it('should handle file read errors', async () => {
      const mockFileNode: IFileNode = {
        depth: 0,
        handle: {
          _internal: { getFile: vi.fn(), kind: 'file', name: 'test.txt' },
          kind: 'file',
          name: 'test.txt',
          path: '/canonical/test.txt',
          platform: 'web',
          rootId: 'durable-root',
        },
        name: 'test.txt',
        path: '/test/path',
        rootFolderId: 'test-folder',
        selectionState: 'unchecked',
        size: 100,
        type: 'file',
      };

      mockFindNodeByPath.mockReturnValue(mockFileNode);
      mockReadFile.mockRejectedValue(new Error('File read error'));

      const { result } = renderHook(() => useFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [mockFileNode], {});
      });

      expect(result.current.progress?.errors).toEqual([
        {
          error: 'Failed to read file: File read error',
          file: '/test/path',
        },
        {
          error: 'No valid files to import',
          file: 'Import Process',
        },
      ]);
    });

    it('imports selected files through the adapter when the lazy tree has not materialized them', async () => {
      mockFindNodeByPath.mockReturnValue(null);
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue({
          name: 'path',
          size: 'file content from cached handle'.length,
          async text() {
            return 'file content from cached handle';
          },
        } as unknown as File),
        kind: 'file',
        name: 'path',
      } as unknown as FileSystemFileHandle;
      mockGetFileHandle.mockResolvedValue(fileHandle);
      mockReadFile.mockResolvedValue('file content from cached handle');

      const { result } = renderHook(() => useFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {});
      });

      expect(mockGetFileHandle).toHaveBeenCalledWith('test-folder', '/test/path');
      expect(mockBulkImport).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            content: 'file content from cached handle',
            name: 'path',
            path: '/test/path',
            size: 'file content from cached handle'.length,
          }),
        ],
        expect.any(Function)
      );
    });
  });
});
