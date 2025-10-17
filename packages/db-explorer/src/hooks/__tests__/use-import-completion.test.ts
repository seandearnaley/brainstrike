import { describe, expect, it, vi } from 'vitest';
import type { EnhancedImportResult } from '../../types';
import { createImportCompletionHandler } from '../use-import-completion';

describe('createImportCompletionHandler', () => {
  it('handles successful imports with chunks and embeddings', async () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 10,
        chunksWithEmbeddings: 8,
      },
      {
        id: 'test2.txt',
        imported: true,
        existed: false,
        chunksCreated: 5,
        chunksWithEmbeddings: 5,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '2 files imported, 15 chunks created, 13 embeddings generated',
      variant: 'default',
    });

    expect(mockLoadRecords).toHaveBeenCalled();
    expect(mockLoadChunks).toHaveBeenCalled();
  });

  it('handles imports with failures', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 10,
        chunksWithEmbeddings: 10,
      },
      {
        id: 'test2.txt',
        imported: false,
        existed: false,
        chunksCreated: 0,
        error: 'Failed to import',
      },
      {
        id: 'test3.txt',
        imported: false,
        existed: false,
        chunksCreated: 0,
        error: 'Access denied',
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 files imported, 2 import failed, 10 chunks created, 10 embeddings generated',
      variant: 'destructive',
    });
  });

  it('handles imports with processing errors', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 0,
        chunksWithEmbeddings: 0,
      },
      {
        id: 'test2.txt',
        imported: true,
        existed: false,
        error: 'Processing failed',
        chunksCreated: 5,
        chunksWithEmbeddings: 0,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '2 files imported, 1 processing errors, 5 chunks created',
      variant: 'default',
    });
  });

  it('handles all imports failing', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: false,
        existed: false,
        chunksCreated: 0,
        error: 'Failed',
      },
      {
        id: 'test2.txt',
        imported: false,
        existed: false,
        chunksCreated: 0,
        error: 'Failed',
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '0 files imported, 2 import failed',
      variant: 'destructive',
    });
  });

  it('handles empty results', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    handler([]);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '0 files imported',
      variant: 'default',
    });
  });

  it('handles imports with only chunks created but no embeddings', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 10,
        chunksWithEmbeddings: 0,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 files imported, 10 chunks created',
      variant: 'default',
    });
  });

  it('handles mixed success and processing errors', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 10,
        chunksWithEmbeddings: 10,
      },
      {
        id: 'test2.txt',
        imported: true,
        existed: false,
        error: 'Partial failure',
        chunksCreated: 5,
        chunksWithEmbeddings: 3,
      },
      {
        id: 'test3.txt',
        imported: false,
        existed: false,
        chunksCreated: 0,
        error: 'Import failed',
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description:
        '2 files imported, 1 import failed, 1 processing errors, 15 chunks created, 13 embeddings generated',
      variant: 'destructive',
    });
  });
});
