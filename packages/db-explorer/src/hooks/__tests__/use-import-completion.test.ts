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

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '2 new • 15 chunks created, 13 embedded',
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
        id: 'test1.txt',
        imported: true,
        existed: false,
        chunksCreated: 1,
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
      title: 'Import Completed with Errors',
      description: '1 new • 10 chunks created, 10 embedded, 2 failed',
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
      description: '2 new • 5 chunks created, 1 errors',
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
      title: 'Import Completed with Errors',
      description: '2 failed',
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
      description: 'No files processed',
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
      description: '1 new • 10 chunks created',
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
      title: 'Import Completed with Errors',
      description: '2 new • 15 chunks created, 13 embedded, 1 failed, 1 errors',
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
      id: `test${i}.txt`,
      imported: false,
      existed: true,
      chunksCreated: 2,
      chunksWithEmbeddings: 2,
    }));

    handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '10 existing • 20 chunks created, 20 embedded',
      variant: 'default',
    });
  });
});
