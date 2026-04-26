import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyExplicitSelection,
  buildQuerySelectionDescriptor,
  collectAncestorDirectories,
  hasPersistApi,
  yieldToBrowser,
} from '../recursive-selection-utils';

describe('recursive-selection-utils', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses timeout-based yielding even when requestAnimationFrame exists', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);

    const yielded = vi.fn();
    const promise = yieldToBrowser().then(yielded);

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(yielded).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await promise;

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(yielded).toHaveBeenCalledTimes(1);
  });

  it('detects stores with a persist api', () => {
    expect(hasPersistApi(() => undefined)).toBe(false);
    expect(
      hasPersistApi(
        Object.assign(() => undefined, {
          persist: {
            getOptions: () => ({}),
          },
        })
      )
    ).toBe(true);
  });

  it('applies small explicit selections in a single call', async () => {
    const addMultipleSelectedFiles = vi.fn();

    await applyExplicitSelection(['/a.ts', '/b.ts'], 'root', addMultipleSelectedFiles);

    expect(addMultipleSelectedFiles).toHaveBeenCalledTimes(1);
    expect(addMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/a.ts', '/b.ts']);
  });

  it('applies large explicit selections in chunks with browser yields', async () => {
    vi.useFakeTimers();
    const addMultipleSelectedFiles = vi.fn();
    const filePaths = Array.from({ length: 120 }, (_, index) => `/file-${index}.ts`);

    const promise = applyExplicitSelection(filePaths, 'root', addMultipleSelectedFiles);
    await vi.runAllTimersAsync();
    await promise;

    expect(addMultipleSelectedFiles.mock.calls.length).toBeGreaterThan(1);
    expect(addMultipleSelectedFiles.mock.calls.flatMap((call) => call[1])).toEqual(filePaths);
  });

  it('applies large explicit selections through the optimized chunked store action when available', async () => {
    const addMultipleSelectedFiles = vi.fn();
    const addMultipleSelectedFilesChunked = vi.fn(async () => ({
      addedCount: 120,
      cancelled: false,
      limitReached: false,
    }));
    const signal = new AbortController().signal;
    const filePaths = Array.from({ length: 120 }, (_, index) => `/file-${index}.ts`);

    await applyExplicitSelection(filePaths, 'root', addMultipleSelectedFiles, {
      addMultipleSelectedFilesChunked,
      signal,
    });

    expect(addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(addMultipleSelectedFilesChunked).toHaveBeenCalledTimes(1);
    expect(addMultipleSelectedFilesChunked).toHaveBeenCalledWith('root', filePaths, {
      signal,
    });
  });

  it('collects ancestor directories in sorted order', () => {
    expect(
      collectAncestorDirectories([
        '/src/index.ts',
        '/src/nested/file.ts',
        '/src/nested/deeper/a.ts',
      ])
    ).toEqual(['/src', '/src/nested', '/src/nested/deeper']);
  });

  it('builds a stable query selection descriptor copy', () => {
    const descriptor = buildQuerySelectionDescriptor({
      kind: 'recursive-select-all',
      folderId: 'root',
      rootPath: '/src',
      coveredDirectoryPaths: ['/src'],
      includeFilters: ['**/*.ts'],
      excludeFilters: ['**/*.test.ts'],
      includedPaths: ['/src/manual.ts'],
      excludedPaths: ['/src/skip.ts'],
      manifestFingerprint: 'fp',
      manifestSnapshotId: 'snapshot',
      totalSelectedCount: 2,
      useRegex: false,
    });

    expect(descriptor).toEqual({
      kind: 'recursive-select-all',
      folderId: 'root',
      rootPath: '/src',
      coveredDirectoryPaths: ['/src'],
      includeFilters: ['**/*.ts'],
      excludeFilters: ['**/*.test.ts'],
      includedPaths: ['/src/manual.ts'],
      excludedPaths: ['/src/skip.ts'],
      manifestFingerprint: 'fp',
      manifestSnapshotId: 'snapshot',
      totalSelectedCount: 2,
      useRegex: false,
    });
  });
});
