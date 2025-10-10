import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnhancedFileImportService } from '../enhanced-file-import-service';

const { runEnhancedImportMock } = vi.hoisted(() => ({
  runEnhancedImportMock: vi.fn(),
}));

// Mock the base service to prevent provider issues
vi.mock('../base-file-import-service', () => ({
  useFileImportService: vi.fn(() => ({
    importFiles: vi.fn(),
    isImporting: false,
    progress: null,
  })),
}));

// Mock dependencies
vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => ({
    findById: vi.fn(),
    update: vi.fn(),
  }),
  useFileChunkRepository: () => ({
    insertMany: vi.fn(),
    update: vi.fn(),
  }),
  usePGliteDatabase: () => null,
  useClearAllData: () => null,
  CHUNKING_CONFIG: {
    defaultMaxTokens: 1000,
    defaultOverlap: 200,
    embeddingInitializationDelay: 100,
    embeddingProcessingDelay: 10,
    chunkPreviewLength: 50,
  },
  ChunkingService: vi.fn().mockImplementation(() => ({
    chunkContent: vi.fn(),
  })),
  useDbProviderError: () => null,
  useFactoryReset: () => null,
}));

vi.mock('@brainstrike/embeddings', () => ({
  SimpleEmbeddingService: vi.fn().mockImplementation(() => ({
    initializeWithModel: vi.fn(),
    generateEmbedding: vi.fn(),
    getStatus: vi.fn().mockReturnValue('ready'),
    dispose: vi.fn(),
  })),
}));

vi.mock('@brainstrike/utils', () => ({
  fileExplorer: {
    getFileExtension: vi.fn(() => '.ts'),
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@brainstrike/file-import', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/file-import')>(
    '@brainstrike/file-import'
  );
  return {
    ...actual,
    runEnhancedImport: runEnhancedImportMock,
  };
});

describe('useEnhancedFileImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEnhancedImportMock.mockReset();
    runEnhancedImportMock.mockImplementation(async (params) => {
      const baseResults = await params.baseImportRunner({
        selectedFilePaths: params.request.selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
      });
      return baseResults.map((result) => ({
        ...result,
        chunksCreated: 0,
      }));
    });
  });

  describe('Basic functionality', () => {
    it('should initialize with correct default state', () => {
      const { result } = renderHook(() => useEnhancedFileImportService());

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
      expect(result.current.chunkRepository).toBeDefined();
    });

    it('should accept options parameter', () => {
      const options = {
        onProgress: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
        enableChunking: true,
        enableEmbedding: true,
        embeddingModel: 'test-model',
      };

      const { result } = renderHook(() => useEnhancedFileImportService(options));

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should call base import service on importFiles', async () => {
      const mockBaseImport = vi.fn();
      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      const { result } = renderHook(() => useEnhancedFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(mockBaseImport).toHaveBeenCalledWith(new Set(['test-folder:/test/path']), [], {
        'test-folder:/test/path': 'test content',
      });
    });

    it('should handle import errors', async () => {
      runEnhancedImportMock.mockRejectedValueOnce(new Error('Import failed'));
      const onError = vi.fn();

      const { result } = renderHook(() => useEnhancedFileImportService({ onError }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Import failed',
        })
      );
    });

    it('should handle chunking disabled', async () => {
      const onComplete = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });
      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file1', imported: true, existed: false, chunksCreated: 0 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          enableChunking: false,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'file1',
          chunksCreated: 0,
        }),
      ]);
    });

    it('should handle chunking enabled', async () => {
      const onComplete = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file1', imported: true, existed: false, chunksCreated: 3 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          enableChunking: true,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chunking: expect.objectContaining({ enabled: true }),
        })
      );
      expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ chunksCreated: 3 })]);
    });
  });
});
