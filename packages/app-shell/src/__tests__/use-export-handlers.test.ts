import type { FileChunk, FileRecord } from '@brainstrike/db';
import type { useToast } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as csvExportUtils from '../../../db-explorer/src/csv-export-utils';
import { useExportHandlers } from '../../../db-explorer/src/hooks/use-export-handlers';

// Type for the toast function from useToast hook
type ToastFn = ReturnType<typeof useToast>['toast'];

// Mock the CSV export utilities at the resolved path
vi.mock('../../../db-explorer/src/csv-export-utils', () => ({
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
    vi.fn().mockResolvedValue({ chunks, records });

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
          content: 'content1',
          createdAt: '2025-01-01T00:00:00Z',
          id: '1',
          name: 'test1.txt',
          path: '/test1.txt',
          size: 8,
          updatedAt: '2025-01-01T00:00:00Z',
        },
        {
          content: 'content2',
          createdAt: '2025-01-01T00:00:00Z',
          id: '2',
          name: 'test2.txt',
          path: '/test2.txt',
          size: 8,
          updatedAt: '2025-01-01T00:00:00Z',
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
        description: 'Exported 2 files to files-export.csv',
        title: 'Export Successful',
      });
    });

    it('shows error when no records to export', async () => {
      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Import some files first before exporting.',
        title: 'No Data to Export',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateFilesWithChunksCSV).not.toHaveBeenCalled();
    });

    it('handles export errors with Error instance', async () => {
      const records: FileRecord[] = [
        {
          createdAt: '2025-01-01T00:00:00Z',
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockImplementation(() => {
        throw new Error('Export generation failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Export generation failed',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });

    it('handles export errors with non-Error thrown value', async () => {
      const records: FileRecord[] = [
        {
          createdAt: '2025-01-01T00:00:00Z',
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 0,
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockImplementation(() => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally throwing non-Error to test handler
        throw 'string error';
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, []), mockToast)
      );

      await result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Failed to export files',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportChunks', () => {
    const makeChunk = (id: string, embedding?: number[]): FileChunk => ({
      chunkIndex: 0,
      chunkSize: 10,
      chunkType: 'text',
      content: `chunk-${id}`,
      contentHash: `hash-${id}`,
      createdAt: '2025-01-01T00:00:00Z',
      fileRecordId: '1',
      id,
      tokenCount: 10,
      updatedAt: '2025-01-01T00:00:00Z',
      ...(embedding ? { embedding } : {}),
    });

    it('exports chunks successfully', async () => {
      const chunks = [makeChunk('1'), makeChunk('2')];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportChunks();

      expect(csvExportUtils.generateChunksCSV).toHaveBeenCalledWith(chunks);
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        description: 'Exported 2 chunks to chunks-export.csv',
        title: 'Export Successful',
      });
    });

    it('shows error when no chunks to export', async () => {
      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], []), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Process some files with chunking enabled first.',
        title: 'No Chunks to Export',
        variant: 'destructive',
      });
    });

    it('handles chunk export errors', async () => {
      vi.mocked(csvExportUtils.generateChunksCSV).mockImplementation(() => {
        throw new Error('Chunk export failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], [makeChunk('1')]), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Chunk export failed',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });

    it('handles chunk export with non-Error thrown value', async () => {
      vi.mocked(csvExportUtils.generateChunksCSV).mockImplementation(() => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally throwing non-Error to test handler
        throw 42;
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], [makeChunk('1')]), mockToast)
      );

      await result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Failed to export chunks',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportEmbeddings', () => {
    const makeChunk = (id: string, embedding?: number[]): FileChunk => ({
      chunkIndex: 0,
      chunkSize: 10,
      chunkType: 'text',
      content: `chunk-${id}`,
      contentHash: `hash-${id}`,
      createdAt: '2025-01-01T00:00:00Z',
      fileRecordId: '1',
      id,
      tokenCount: 10,
      updatedAt: '2025-01-01T00:00:00Z',
      ...(embedding ? { embedding } : {}),
    });

    it('exports embeddings successfully', async () => {
      const chunks = [makeChunk('1', [0.1, 0.2]), makeChunk('2', [0.3, 0.4])];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(csvExportUtils.generateEmbeddingsCSV).toHaveBeenCalledWith(chunks);
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        description: 'Exported 2 embeddings to embeddings-export.csv',
        title: 'Export Successful',
      });
    });

    it('shows error when no embeddings to export', async () => {
      const chunks = [makeChunk('1')]; // no embedding

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Generate embeddings for chunks first.',
        title: 'No Embeddings to Export',
        variant: 'destructive',
      });
    });

    it('filters chunks without embeddings', async () => {
      const withEmbedding = makeChunk('2', [0.1, 0.2]);
      const chunks = [makeChunk('1'), withEmbedding];

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], chunks), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(csvExportUtils.generateEmbeddingsCSV).toHaveBeenCalledWith([withEmbedding]);
      expect(mockToast).toHaveBeenCalledWith({
        description: 'Exported 1 embeddings to embeddings-export.csv',
        title: 'Export Successful',
      });
    });

    it('handles embedding export errors', async () => {
      vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockImplementation(() => {
        throw new Error('Embedding export failed');
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], [makeChunk('1', [0.1])]), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Embedding export failed',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });

    it('handles embedding export with non-Error thrown value', async () => {
      vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockImplementation(() => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally throwing non-Error to test handler
        throw null;
      });

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], [makeChunk('1', [0.1])]), mockToast)
      );

      await result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Failed to export embeddings',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportAll', () => {
    const makeRecord = (id: string): FileRecord => ({
      createdAt: '2025-01-01T00:00:00Z',
      id,
      name: `test-${id}.txt`,
      path: `/test-${id}.txt`,
      size: 0,
      updatedAt: '2025-01-01T00:00:00Z',
    });

    const makeChunk = (id: string): FileChunk => ({
      chunkIndex: 0,
      chunkSize: 0,
      chunkType: 'text',
      content: '',
      contentHash: `hash-${id}`,
      createdAt: '2025-01-01T00:00:00Z',
      fileRecordId: '1',
      id,
      tokenCount: 0,
      updatedAt: '2025-01-01T00:00:00Z',
    });

    it('exports all data as zip', async () => {
      const records = [makeRecord('1')];
      const chunks = [makeChunk('1')];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData(records, chunks), mockToast)
      );

      await result.current.handleExportAll();

      expect(csvExportUtils.exportAllDataAsZip).toHaveBeenCalledWith(records, chunks);
      expect(mockToast).toHaveBeenCalledWith({
        description: 'All data exported as ZIP archive',
        title: 'Export Successful',
      });
    });

    it('shows error when no data to export', async () => {
      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([], []), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Import some files first before exporting.',
        title: 'No Data to Export',
        variant: 'destructive',
      });
      expect(csvExportUtils.exportAllDataAsZip).not.toHaveBeenCalled();
    });

    it('handles zip export errors with Error instance', async () => {
      vi.mocked(csvExportUtils.exportAllDataAsZip).mockRejectedValue(
        new Error('ZIP export failed')
      );

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([makeRecord('1')], []), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'ZIP export failed',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });

    it('handles zip export errors with non-Error thrown value', async () => {
      vi.mocked(csvExportUtils.exportAllDataAsZip).mockRejectedValue('oops');

      const { result } = renderHook(() =>
        useExportHandlers(createLoadExportData([makeRecord('1')], []), mockToast)
      );

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Failed to export all data',
        title: 'Export Failed',
        variant: 'destructive',
      });
    });
  });
});
