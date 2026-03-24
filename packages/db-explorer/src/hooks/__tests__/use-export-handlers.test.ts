import type { FileChunk, FileRecord } from '@brainstrike/db';
import type { useToast } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as csvExportUtils from '../../csv-export-utils';
import { useExportHandlers } from '../use-export-handlers';

// Type for the toast function from useToast hook
type ToastFn = ReturnType<typeof useToast>['toast'];

// Mock the CSV export utilities
vi.mock('../../csv-export-utils', () => ({
  createCSVBlob: vi.fn((content: string) => new Blob([content], { type: 'text/csv' })),
  exportAllDataAsZip: vi.fn(),
  generateChunksCSV: vi.fn(() => 'chunk,data'),
  generateCSVFilename: vi.fn((type: string) => `${type}-export.csv`),
  generateEmbeddingsCSV: vi.fn(() => 'embedding,data'),
  generateFilesWithChunksCSV: vi.fn(() => 'file,data'),
}));

describe('useExportHandlers', () => {
  let mockToast: Mock<ToastFn>;
  let mockLink: HTMLAnchorElement;
  let originalCreateElement: typeof document.createElement;

  const createLoadExportData = (records: FileRecord[], chunks: FileChunk[]) =>
    vi.fn().mockResolvedValue({ records, chunks });

  beforeEach(() => {
    vi.resetAllMocks();
    // Restore default mock implementations after resetAllMocks clears them
    vi.mocked(csvExportUtils.createCSVBlob).mockImplementation(
      (content: string) => new Blob([content], { type: 'text/csv' })
    );
    vi.mocked(csvExportUtils.generateChunksCSV).mockReturnValue('chunk,data');
    vi.mocked(csvExportUtils.generateCSVFilename).mockImplementation(
      (prefix?: string) => `${prefix ?? 'export'}-export.csv`
    );
    vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockReturnValue('embedding,data');
    vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockReturnValue('file,data');
    mockToast = vi.fn() as Mock<ToastFn>;

    // Save original createElement
    originalCreateElement = document.createElement.bind(document);

    // Create a real anchor element and spy on its click method
    mockLink = originalCreateElement('a');
    vi.spyOn(mockLink, 'click').mockImplementation(() => {});

    // Spy on createElement to return our mockLink for anchor elements
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') {
        return mockLink;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    // Mock URL methods
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleExportFiles', () => {
    it('exports files successfully', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test1.txt',
          path: '/test1.txt',
          size: 8,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          content: 'content1',
        },
        {
          id: '2',
          name: 'test2.txt',
          path: '/test2.txt',
          size: 8,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          content: 'content2',
        },
      ];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportFiles();

      expect(csvExportUtils.generateFilesWithChunksCSV).toHaveBeenCalledWith(records);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('files');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 files to files-export.csv',
      });
    });

    it('shows error when no records to export', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateFilesWithChunksCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];
      const chunks: FileChunk[] = [];

      vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockImplementation(() => {
        throw new Error('Export generation failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Export generation failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportChunks', () => {
    it('exports chunks successfully', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'chunk1',
          contentHash: 'hash1',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: '2',
          fileRecordId: '1',
          chunkIndex: 1,
          content: 'chunk2',
          contentHash: 'hash2',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(csvExportUtils.generateChunksCSV).toHaveBeenCalledWith(chunks);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('chunks');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 chunks to chunks-export.csv',
      });
    });

    it('shows error when no chunks to export', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Chunks to Export',
        description: 'Process some files with chunking enabled first.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateChunksCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: '',
          contentHash: 'hash1',
          tokenCount: 0,
          chunkType: 'text',
          chunkSize: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.generateChunksCSV).mockImplementation(() => {
        throw new Error('Chunk export failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Chunk export failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportEmbeddings', () => {
    it('exports embeddings successfully', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'chunk1',
          contentHash: 'hash1',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          embedding: [0.1, 0.2, 0.3],
        },
        {
          id: '2',
          fileRecordId: '1',
          chunkIndex: 1,
          content: 'chunk2',
          contentHash: 'hash2',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          embedding: [0.4, 0.5, 0.6],
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(csvExportUtils.generateEmbeddingsCSV).toHaveBeenCalledWith(chunks);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('embeddings');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 embeddings to embeddings-export.csv',
      });
    });

    it('shows error when no embeddings to export', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'chunk1',
          contentHash: 'hash1',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Embeddings to Export',
        description: 'Generate embeddings for chunks first.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateEmbeddingsCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'chunk1',
          contentHash: 'hash1',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          embedding: [0.1, 0.2],
        },
      ];

      vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockImplementation(() => {
        throw new Error('Embedding export failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Embedding export failed',
        variant: 'destructive',
      });
    });

    it('filters chunks without embeddings', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'chunk1',
          contentHash: 'hash1',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: '2',
          fileRecordId: '1',
          chunkIndex: 1,
          content: 'chunk2',
          contentHash: 'hash2',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          embedding: [0.1, 0.2],
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(csvExportUtils.generateEmbeddingsCSV).toHaveBeenCalledWith([chunks[1]]);
      // Should export only the chunk with embedding
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 1 embeddings to embeddings-export.csv',
      });
    });
  });

  describe('handleExportAll', () => {
    it('exports all data as zip successfully', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: '',
          contentHash: 'hash1',
          tokenCount: 0,
          chunkType: 'text',
          chunkSize: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportAll();

      expect(csvExportUtils.exportAllDataAsZip).toHaveBeenCalledWith(records, chunks);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'All data exported as ZIP archive',
      });
    });

    it('shows error when no data to export', async () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      expect(csvExportUtils.exportAllDataAsZip).not.toHaveBeenCalled();
    });

    it('handles export errors', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];
      const chunks: FileChunk[] = [];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockRejectedValue(
        new Error('ZIP export failed')
      );

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'ZIP export failed',
        variant: 'destructive',
      });
    });

    it('uses generic message when a non-Error is thrown', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];
      const chunks: FileChunk[] = [];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockRejectedValue('non-error string');

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Failed to export all data',
        variant: 'destructive',
      });
    });
  });

  describe('non-Error throws – generic fallback message', () => {
    it('handleExportFiles falls back to generic message on non-Error throw', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        // biome-ignore lint/style/useThrowOnlyError: testing non-Error throw handling
        throw 'raw string error';
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Failed to export files',
        variant: 'destructive',
      });
    });

    it('handleExportChunks falls back to generic message on non-Error throw', async () => {
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'x',
          contentHash: 'h',
          tokenCount: 1,
          chunkType: 'text',
          chunkSize: 1,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.generateChunksCSV).mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        // biome-ignore lint/style/useThrowOnlyError: testing non-Error throw handling
        throw 42;
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Failed to export chunks',
        variant: 'destructive',
      });
    });

    it('handleExportEmbeddings falls back to generic message on non-Error throw', async () => {
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'x',
          contentHash: 'h',
          tokenCount: 1,
          chunkType: 'text',
          chunkSize: 1,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          embedding: [0.1],
        },
      ];

      vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        // biome-ignore lint/style/useThrowOnlyError: testing non-Error throw handling
        throw null;
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Failed to export embeddings',
        variant: 'destructive',
      });
    });
  });

  describe('URL and DOM lifecycle', () => {
    it('revokes the object URL after a successful file export', async () => {
      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('revokes the object URL after a successful chunk export', async () => {
      const chunks: FileChunk[] = [
        {
          id: '1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'x',
          contentHash: 'h',
          tokenCount: 1,
          chunkType: 'text',
          chunkSize: 1,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('appends then removes the anchor from the document body', async () => {
      const appendSpy = vi.spyOn(document.body, 'appendChild');
      const removeSpy = vi.spyOn(document.body, 'removeChild');

      const records: FileRecord[] = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(appendSpy).toHaveBeenCalledWith(mockLink);
      expect(removeSpy).toHaveBeenCalledWith(mockLink);
    });
  });

  describe('loadExportData rejection', () => {
    it('surfaces a toast when loadExportData itself rejects', async () => {
      const failingLoader = vi.fn().mockRejectedValue(new Error('DB unavailable'));

      const { result } = renderHook(() => useExportHandlers(failingLoader, mockToast));

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'DB unavailable',
        variant: 'destructive',
      });
    });

    it('uses generic message when loadExportData rejects with a non-Error', async () => {
      const failingLoader = vi.fn().mockRejectedValue('network timeout');

      const { result } = renderHook(() => useExportHandlers(failingLoader, mockToast));

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Failed to export chunks',
        variant: 'destructive',
      });
    });
  });
});
