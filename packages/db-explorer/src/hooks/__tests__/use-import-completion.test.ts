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
        chunksCreated: 10,
        chunksWithEmbeddings: 8,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
      {
        chunksCreated: 5,
        chunksWithEmbeddings: 5,
        existed: false,
        id: 'test2.txt',
        imported: true,
      },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 new • 15 chunks created, 13 embedded',
      title: 'Import Complete',
      variant: 'default',
    });

    expect(mockLoadRecords).toHaveBeenCalled();
    expect(mockLoadChunks).toHaveBeenCalled();
  });

  it('refreshes collection stats before reloading visible import data', async () => {
    const mockToast = vi.fn();
    const events: string[] = [];
    const mockRefreshCollectionStats = vi.fn(async () => {
      events.push('stats');
    });
    const mockLoadRecords = vi.fn(async () => {
      events.push('records');
    });
    const mockLoadChunks = vi.fn(async () => {
      events.push('chunks');
    });

    const handler = createImportCompletionHandler(
      mockToast,
      mockLoadRecords,
      mockLoadChunks,
      mockRefreshCollectionStats
    );

    await handler([
      {
        chunksCreated: 1,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
    ]);

    expect(events).toEqual(['stats', 'records', 'chunks']);
  });

  it('handles imports with failures', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    const results: EnhancedImportResult[] = [
      {
        chunksCreated: 10,
        chunksWithEmbeddings: 10,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
      {
        chunksCreated: 0,
        error: 'Failed to import',
        existed: false,
        id: 'test2.txt',
        imported: false,
      },
      {
        chunksCreated: 0,
        error: 'Access denied',
        existed: false,
        id: 'test3.txt',
        imported: false,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new • 10 chunks created, 10 embedded, 2 failed',
      title: 'Import Completed with Errors',
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
        chunksCreated: 0,
        chunksWithEmbeddings: 0,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
      {
        chunksCreated: 5,
        chunksWithEmbeddings: 0,
        error: 'Processing failed',
        existed: false,
        id: 'test2.txt',
        imported: true,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 new • 5 chunks created, 1 errors',
      title: 'Import Complete',
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
        chunksCreated: 0,
        error: 'Failed',
        existed: false,
        id: 'test1.txt',
        imported: false,
      },
      {
        chunksCreated: 0,
        error: 'Failed',
        existed: false,
        id: 'test2.txt',
        imported: false,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 failed',
      title: 'Import Completed with Errors',
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
      description: 'No files processed',
      title: 'Import Complete',
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
        chunksCreated: 10,
        chunksWithEmbeddings: 0,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new • 10 chunks created',
      title: 'Import Complete',
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
        chunksCreated: 10,
        chunksWithEmbeddings: 10,
        existed: false,
        id: 'test1.txt',
        imported: true,
      },
      {
        chunksCreated: 5,
        chunksWithEmbeddings: 3,
        error: 'Partial failure',
        existed: false,
        id: 'test2.txt',
        imported: true,
      },
      {
        chunksCreated: 0,
        error: 'Import failed',
        existed: false,
        id: 'test3.txt',
        imported: false,
      },
    ];

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 new • 15 chunks created, 13 embedded, 1 failed, 1 errors',
      title: 'Import Completed with Errors',
      variant: 'destructive',
    });
  });

  it('handles existing files imported to new collection (critical case)', () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);

    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);

    // Simulates importing 10 files that already exist in file_records
    // to a new collection - creates chunks but files have imported:false, existed:true
    const results: EnhancedImportResult[] = Array.from({ length: 10 }, (_, i) => ({
      chunksCreated: 2,
      chunksWithEmbeddings: 2,
      existed: true,
      id: `test${i}.txt`,
      imported: false,
    }));

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '10 existing • 20 chunks created, 20 embedded',
      title: 'Import Complete',
      variant: 'default',
    });
  });
});
