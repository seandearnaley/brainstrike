import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { describe, expect, it, vi } from 'vitest';
import { getImportPathFileName, runFileImport } from '../file-import/file-import-coordinator';

describe('getImportPathFileName', () => {
  it('extracts slash-path file names without path segment array allocation', () => {
    expect(getImportPathFileName('src/index.ts')).toBe('index.ts');
    expect(getImportPathFileName('README.md')).toBe('README.md');
    expect(getImportPathFileName('')).toBe('');
    expect(getImportPathFileName('src/')).toBe('');
  });
});

describe('runFileImport', () => {
  it('routes cached managed-cache imports by root without calling bulkImport', async () => {
    const rootAFile = encodeFileSelection('root-a', 'src/a.ts');
    const rootBFile = encodeFileSelection('root-b', 'docs/b.md');
    const bulkImport = vi.fn(async () => {
      throw new Error('bulkImport must not run for managed-cache imports');
    });
    const applyBatch = vi.fn(async () => undefined);
    const invalidateByIdentity = vi.fn(async () => undefined);

    const outcome = await runFileImport(
      {
        fileSystem: null,
        managedCacheImport: { applyBatch, invalidateByIdentity },
        repository: { bulkImport },
      },
      {
        embeddingSetId: 'collection-1',
        fileContents: {
          [rootAFile]: 'alpha',
          [rootBFile]: 'bravo',
        },
        fileTree: [],
        selectedFilePaths: new Set([rootAFile, rootBFile]),
      }
    );

    expect(bulkImport).not.toHaveBeenCalled();
    expect(invalidateByIdentity).toHaveBeenCalledTimes(2);
    expect(invalidateByIdentity).toHaveBeenNthCalledWith(1, {
      embeddingSetId: 'collection-1',
      targets: [
        {
          mode: 'exact',
          relativePath: 'src/a.ts',
          rootId: 'root-a',
        },
      ],
    });
    expect(invalidateByIdentity).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'collection-1',
      targets: [
        {
          mode: 'exact',
          relativePath: 'docs/b.md',
          rootId: 'root-b',
        },
      ],
    });
    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(invalidateByIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      applyBatch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(invalidateByIdentity.mock.invocationCallOrder[1]).toBeLessThan(
      applyBatch.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    );
    expect(applyBatch).toHaveBeenNthCalledWith(1, {
      embeddingSetId: 'collection-1',
      rootId: 'root-a',
      changes: [
        {
          mode: 'import',
          record: expect.objectContaining({
            content: 'alpha',
            contentHash: expect.any(String),
            createdAt: expect.any(String),
            id: expect.any(String),
            mtimeMs: null,
            name: 'a.ts',
            path: 'src/a.ts',
            processedAt: expect.any(String),
            size: 5,
            tokenCount: expect.any(Number),
            updatedAt: expect.any(String),
          }),
        },
      ],
    });
    expect(applyBatch).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'collection-1',
      rootId: 'root-b',
      changes: [
        {
          mode: 'import',
          record: expect.objectContaining({
            content: 'bravo',
            contentHash: expect.any(String),
            createdAt: expect.any(String),
            id: expect.any(String),
            mtimeMs: null,
            name: 'b.md',
            path: 'docs/b.md',
            processedAt: expect.any(String),
            size: 5,
            tokenCount: expect.any(Number),
            updatedAt: expect.any(String),
          }),
        },
      ],
    });
    expect(outcome.results).toEqual([
      {
        existed: false,
        id: expect.any(String),
        imported: true,
      },
      {
        existed: false,
        id: expect.any(String),
        imported: true,
      },
    ]);
    expect(outcome.progress).toMatchObject({
      completed: 2,
      errors: [],
      total: 2,
    });
  });
});
