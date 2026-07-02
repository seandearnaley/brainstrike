import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { describe, expect, it, vi } from 'vitest';
import { getImportPathFileName, runFileImport } from '../file-import/file-import-coordinator';
import type { ManagedCacheImportPort } from '../file-import/file-import-types';

describe('getImportPathFileName', () => {
  it('extracts slash-path file names without path segment array allocation', () => {
    expect(getImportPathFileName('src/index.ts')).toBe('index.ts');
    expect(getImportPathFileName('README.md')).toBe('README.md');
    expect(getImportPathFileName('')).toBe('');
    expect(getImportPathFileName('src/')).toBe('');
  });
});

describe('runFileImport', () => {
  it('routes cached managed-cache imports by root without calling bulkImport or invalidating first', async () => {
    const rootAFile = encodeFileSelection('root-a', 'src/a.ts');
    const rootBFile = encodeFileSelection('root-b', 'docs/b.md');
    const bulkImport = vi.fn(async () => {
      throw new Error('bulkImport must not run for managed-cache imports');
    });
    const applyBatch = vi.fn<ManagedCacheImportPort['applyBatch']>(async () => undefined);
    const findExistingByIdentity = vi.fn(async ({ rootId }: { rootId: string }) =>
      rootId === 'root-a' ? [{ id: 'existing-a', path: 'src/a.ts' }] : []
    );

    const outcome = await runFileImport(
      {
        fileSystem: null,
        managedCacheImport: { applyBatch, findExistingByIdentity },
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
    expect(findExistingByIdentity).toHaveBeenCalledTimes(2);
    expect(findExistingByIdentity).toHaveBeenNthCalledWith(1, {
      embeddingSetId: 'collection-1',
      relativePaths: ['src/a.ts'],
      rootId: 'root-a',
    });
    expect(findExistingByIdentity).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'collection-1',
      relativePaths: ['docs/b.md'],
      rootId: 'root-b',
    });
    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(findExistingByIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      applyBatch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(findExistingByIdentity.mock.invocationCallOrder[1]).toBeLessThan(
      applyBatch.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    );
    expect(applyBatch).toHaveBeenNthCalledWith(1, {
      embeddingSetId: 'collection-1',
      rootId: 'root-a',
      changes: [
        {
          mode: 'replace',
          record: expect.objectContaining({
            content: 'alpha',
            contentHash: expect.any(String),
            id: 'existing-a',
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
    const firstApplyArgs = applyBatch.mock.calls[0]?.[0];
    if (!firstApplyArgs) {
      throw new Error('Expected managed-cache applyBatch to be called for root-a.');
    }
    const firstChange = firstApplyArgs.changes[0];
    if (!firstChange) {
      throw new Error('Expected managed-cache applyBatch to receive a root-a change.');
    }
    if (firstChange.mode !== 'replace') {
      throw new Error('Expected first managed-cache applyBatch change to be replace.');
    }
    expect(firstChange.record).not.toHaveProperty('createdAt');
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
        existed: true,
        id: 'existing-a',
        imported: false,
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

  it('preserves managed-cache import result order when requests are grouped by root', async () => {
    const rootAFirstFile = encodeFileSelection('root-a', 'src/a.ts');
    const rootBFile = encodeFileSelection('root-b', 'docs/b.md');
    const rootASecondFile = encodeFileSelection('root-a', 'src/c.ts');
    const bulkImport = vi.fn(async () => {
      throw new Error('bulkImport must not run for managed-cache imports');
    });
    const applyBatch = vi.fn<ManagedCacheImportPort['applyBatch']>(async () => undefined);
    const findExistingByIdentity = vi.fn<ManagedCacheImportPort['findExistingByIdentity']>(
      async ({ relativePaths, rootId }) => {
        if (rootId !== 'root-a') {
          return [];
        }
        return relativePaths.map((path) => ({
          id: path === 'src/a.ts' ? 'existing-a' : 'existing-c',
          path,
        }));
      }
    );

    const outcome = await runFileImport(
      {
        fileSystem: null,
        managedCacheImport: { applyBatch, findExistingByIdentity },
        repository: { bulkImport },
      },
      {
        embeddingSetId: 'collection-1',
        fileContents: {
          [rootAFirstFile]: 'alpha',
          [rootBFile]: 'bravo',
          [rootASecondFile]: 'charlie',
        },
        fileTree: [],
        selectedFilePaths: new Set([rootAFirstFile, rootBFile, rootASecondFile]),
      }
    );

    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(applyBatch.mock.calls[0]?.[0]).toMatchObject({
      rootId: 'root-a',
      changes: [
        { mode: 'replace', record: { id: 'existing-a', path: 'src/a.ts' } },
        { mode: 'replace', record: { id: 'existing-c', path: 'src/c.ts' } },
      ],
    });
    expect(applyBatch.mock.calls[1]?.[0]).toMatchObject({
      rootId: 'root-b',
      changes: [{ mode: 'import', record: { path: 'docs/b.md' } }],
    });
    expect(outcome.results).toEqual([
      { existed: true, id: 'existing-a', imported: false },
      { existed: false, id: expect.any(String), imported: true },
      { existed: true, id: 'existing-c', imported: false },
    ]);
  });
});
