import type { FileChunk, FileRecord } from '@brainstrike/db';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as csvExportUtils from '../../csv-export-utils';
import { useExportHandlers } from '../use-export-handlers';

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
  let mockToast: ReturnType<typeof vi.fn>;
  let mockLink: HTMLAnchorElement;
  let originalCreateElement: typeof document.createElement;

  beforeEach(() => {
    mockToast = vi.fn();

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
    it('exports files successfully', () => {
      const records: FileRecord[] = [
        { id: 1, filepath: 'test1.txt', content: 'content1' } as FileRecord,
        { id: 2, filepath: 'test2.txt', content: 'content2' } as FileRecord,
      ];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportFiles();

      expect(csvExportUtils.generateFilesWithChunksCSV).toHaveBeenCalledWith(records);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('files');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 files to files-export.csv',
      });
    });

    it('shows error when no records to export', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateFilesWithChunksCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', () => {
      const records: FileRecord[] = [{ id: 1, filepath: 'test.txt' } as FileRecord];
      const chunks: FileChunk[] = [];

      vi.mocked(csvExportUtils.generateFilesWithChunksCSV).mockImplementation(() => {
        throw new Error('Export generation failed');
      });

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportFiles();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Export generation failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportChunks', () => {
    it('exports chunks successfully', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        { id: 1, file_id: 1, content: 'chunk1' } as FileChunk,
        { id: 2, file_id: 1, content: 'chunk2' } as FileChunk,
      ];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportChunks();

      expect(csvExportUtils.generateChunksCSV).toHaveBeenCalledWith(chunks);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('chunks');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 chunks to chunks-export.csv',
      });
    });

    it('shows error when no chunks to export', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Chunks to Export',
        description: 'Process some files with chunking enabled first.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateChunksCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [{ id: 1, file_id: 1 } as FileChunk];

      vi.mocked(csvExportUtils.generateChunksCSV).mockImplementation(() => {
        throw new Error('Chunk export failed');
      });

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportChunks();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Chunk export failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleExportEmbeddings', () => {
    it('exports embeddings successfully', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        { id: 1, file_id: 1, content: 'chunk1', embedding: [0.1, 0.2, 0.3] } as FileChunk,
        { id: 2, file_id: 1, content: 'chunk2', embedding: [0.4, 0.5, 0.6] } as FileChunk,
      ];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportEmbeddings();

      expect(csvExportUtils.generateEmbeddingsCSV).toHaveBeenCalledWith(chunks);
      expect(csvExportUtils.createCSVBlob).toHaveBeenCalled();
      expect(csvExportUtils.generateCSVFilename).toHaveBeenCalledWith('embeddings');
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 2 embeddings to embeddings-export.csv',
      });
    });

    it('shows error when no embeddings to export', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [{ id: 1, file_id: 1, content: 'chunk1' } as FileChunk];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Embeddings to Export',
        description: 'Generate embeddings for chunks first.',
        variant: 'destructive',
      });
      expect(csvExportUtils.generateEmbeddingsCSV).not.toHaveBeenCalled();
    });

    it('handles export errors', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        { id: 1, file_id: 1, content: 'chunk1', embedding: [0.1, 0.2] } as FileChunk,
      ];

      vi.mocked(csvExportUtils.generateEmbeddingsCSV).mockImplementation(() => {
        throw new Error('Embedding export failed');
      });

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportEmbeddings();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'Embedding export failed',
        variant: 'destructive',
      });
    });

    it('filters chunks without embeddings', () => {
      const records: FileRecord[] = [];
      const chunks: FileChunk[] = [
        { id: 1, file_id: 1, content: 'chunk1' } as FileChunk,
        { id: 2, file_id: 1, content: 'chunk2', embedding: [0.1, 0.2] } as FileChunk,
      ];

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      result.current.handleExportEmbeddings();

      // Should export only the chunk with embedding
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Successful',
        description: 'Exported 1 embeddings to embeddings-export.csv',
      });
    });
  });

  describe('handleExportAll', () => {
    it('exports all data as zip successfully', async () => {
      const records: FileRecord[] = [{ id: 1, filepath: 'test.txt' } as FileRecord];
      const chunks: FileChunk[] = [{ id: 1, file_id: 1 } as FileChunk];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockResolvedValue(undefined);

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

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

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      expect(csvExportUtils.exportAllDataAsZip).not.toHaveBeenCalled();
    });

    it('handles export errors', async () => {
      const records: FileRecord[] = [{ id: 1, filepath: 'test.txt' } as FileRecord];
      const chunks: FileChunk[] = [];

      vi.mocked(csvExportUtils.exportAllDataAsZip).mockRejectedValue(
        new Error('ZIP export failed')
      );

      const { result } = renderHook(() => useExportHandlers(records, chunks, mockToast));

      await result.current.handleExportAll();

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Export Failed',
        description: 'ZIP export failed',
        variant: 'destructive',
      });
    });
  });
});
