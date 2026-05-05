import { describe, expect, it, vi } from 'vitest';
import { createImportCompletionHandler } from '../../../db-explorer/src/hooks/use-import-completion';
import type { EnhancedImportResult } from '../../../db-explorer/src/types';

describe('createImportCompletionHandler', () => {
  const setup = () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);
    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);
    return { mockToast, mockLoadRecords, mockLoadChunks, handler };
  };

  it('reports successful import of new files with chunks and embeddings', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: true, existed: false, chunksCreated: 10, chunksWithEmbeddings: 8 },
      { id: 'b.txt', imported: true, existed: false, chunksCreated: 5, chunksWithEmbeddings: 5 },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '2 new • 15 chunks created, 13 embedded',
      variant: 'default',
    });
  });

  it('reports failures with destructive variant', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: true, existed: false, chunksCreated: 10, chunksWithEmbeddings: 10 },
      { id: 'b.txt', imported: false, existed: false, chunksCreated: 0, error: 'Failed' },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Completed with Errors',
      description: '1 new • 10 chunks created, 10 embedded, 1 failed',
      variant: 'destructive',
    });
  });

  it('reports existing files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: false, existed: true, chunksCreated: 3, chunksWithEmbeddings: 3 },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 existing • 3 chunks created, 3 embedded',
      variant: 'default',
    });
  });

  it('reports mixed new and existing files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: true, existed: false, chunksCreated: 2, chunksWithEmbeddings: 0 },
      { id: 'b.txt', imported: false, existed: true, chunksCreated: 1, chunksWithEmbeddings: 0 },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 new, 1 existing • 3 chunks created',
      variant: 'default',
    });
  });

  it('handles all imports failing', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: false, existed: false, chunksCreated: 0, error: 'Fail' },
      { id: 'b.txt', imported: false, existed: false, chunksCreated: 0, error: 'Fail' },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Completed with Errors',
      description: '2 failed',
      variant: 'destructive',
    });
  });

  it('handles empty results', async () => {
    const { mockToast, handler } = setup();

    await handler([]);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: 'No files processed',
      variant: 'default',
    });
  });

  it('reports processing errors on imported files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      {
        id: 'a.txt',
        imported: true,
        existed: false,
        chunksCreated: 5,
        chunksWithEmbeddings: 0,
        error: 'Partial failure',
      },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 new • 5 chunks created, 1 errors',
      variant: 'default',
    });
  });

  it('shows chunks without embeddings (no embedding line)', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { id: 'a.txt', imported: true, existed: false, chunksCreated: 10, chunksWithEmbeddings: 0 },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import Complete',
      description: '1 new • 10 chunks created',
      variant: 'default',
    });
  });

  it('calls loadRecords and loadChunks after import', async () => {
    const { mockLoadRecords, mockLoadChunks, handler } = setup();

    await handler([]);

    expect(mockLoadRecords).toHaveBeenCalled();
    expect(mockLoadChunks).toHaveBeenCalled();
  });
});
