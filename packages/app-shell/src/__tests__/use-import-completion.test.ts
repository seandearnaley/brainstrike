import { describe, expect, it, vi } from 'vitest';
import { createImportCompletionHandler } from '../../../db-explorer/src/hooks/use-import-completion';
import type { EnhancedImportResult } from '../../../db-explorer/src/types';

describe('createImportCompletionHandler', () => {
  const setup = () => {
    const mockToast = vi.fn();
    const mockLoadRecords = vi.fn().mockResolvedValue(undefined);
    const mockLoadChunks = vi.fn().mockResolvedValue(undefined);
    const handler = createImportCompletionHandler(mockToast, mockLoadRecords, mockLoadChunks);
    return { handler, mockLoadChunks, mockLoadRecords, mockToast };
  };

  it('reports successful import of new files with chunks and embeddings', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 10, chunksWithEmbeddings: 8, existed: false, id: 'a.txt', imported: true },
      { chunksCreated: 5, chunksWithEmbeddings: 5, existed: false, id: 'b.txt', imported: true },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 new • 15 chunks created, 13 embedded',
      title: 'Import Complete',
      variant: 'default',
    });
  });

  it('reports failures with destructive variant', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 10, chunksWithEmbeddings: 10, existed: false, id: 'a.txt', imported: true },
      { chunksCreated: 0, error: 'Failed', existed: false, id: 'b.txt', imported: false },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new • 10 chunks created, 10 embedded, 1 failed',
      title: 'Import Completed with Errors',
      variant: 'destructive',
    });
  });

  it('reports existing files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 3, chunksWithEmbeddings: 3, existed: true, id: 'a.txt', imported: false },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 existing • 3 chunks created, 3 embedded',
      title: 'Import Complete',
      variant: 'default',
    });
  });

  it('reports mixed new and existing files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 2, chunksWithEmbeddings: 0, existed: false, id: 'a.txt', imported: true },
      { chunksCreated: 1, chunksWithEmbeddings: 0, existed: true, id: 'b.txt', imported: false },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new, 1 existing • 3 chunks created',
      title: 'Import Complete',
      variant: 'default',
    });
  });

  it('handles all imports failing', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 0, error: 'Fail', existed: false, id: 'a.txt', imported: false },
      { chunksCreated: 0, error: 'Fail', existed: false, id: 'b.txt', imported: false },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '2 failed',
      title: 'Import Completed with Errors',
      variant: 'destructive',
    });
  });

  it('handles empty results', async () => {
    const { mockToast, handler } = setup();

    await handler([]);

    expect(mockToast).toHaveBeenCalledWith({
      description: 'No files processed',
      title: 'Import Complete',
      variant: 'default',
    });
  });

  it('reports processing errors on imported files', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      {
        chunksCreated: 5,
        chunksWithEmbeddings: 0,
        error: 'Partial failure',
        existed: false,
        id: 'a.txt',
        imported: true,
      },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new • 5 chunks created, 1 errors',
      title: 'Import Complete',
      variant: 'default',
    });
  });

  it('shows chunks without embeddings (no embedding line)', async () => {
    const { mockToast, handler } = setup();

    const results: EnhancedImportResult[] = [
      { chunksCreated: 10, chunksWithEmbeddings: 0, existed: false, id: 'a.txt', imported: true },
    ];

    await handler(results);

    expect(mockToast).toHaveBeenCalledWith({
      description: '1 new • 10 chunks created',
      title: 'Import Complete',
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
