import * as contextGeneration from '@brainstrike/file-explorer/context-generation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportGenerationWorker } from '../report-generation-worker.js';
import { MockFileSystemAdapter } from './test-helpers.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

const baseRequest = {
  excludeFilters: [],
  fileContents: { 'a.ts': 'content' },
  folderSummaryThreshold: 5,
  includeFilters: [],
  includeProjectTree: false,
  selectedFiles: new Set(['a.ts']),
  useRegex: false,
};

describe('report-generation-worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a missing file-system adapter instead of selecting a browser fallback', () => {
    const createWithoutOptions = createReportGenerationWorker as unknown as () => ReturnType<
      typeof createReportGenerationWorker
    >;

    expect(() => createWithoutOptions()).toThrow(
      'File system adapter is required for report generation'
    );
  });

  it('uses the required adapter for context generation', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker({ fileSystemAdapter: adapter });
    const rootHandle = await adapter.requestDirectoryAccess();
    const spy = vi.spyOn(contextGeneration, 'generateContext').mockResolvedValue('report');

    const result = await worker({ ...baseRequest, rootDirectoryHandle: rootHandle });

    expect(spy).toHaveBeenCalled();
    expect(result).toBe('report');
  });

  it('emits progress events', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker({ fileSystemAdapter: adapter });
    const rootHandle = await adapter.requestDirectoryAccess();
    vi.spyOn(contextGeneration, 'generateContext').mockResolvedValue('done');

    const progress: number[] = [];
    await worker({ ...baseRequest, rootDirectoryHandle: rootHandle }, (e) =>
      progress.push(e.loaded)
    );

    expect(progress).toEqual([0, 1]);
  });

  it('passes the tree filter option when provided', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker({ fileSystemAdapter: adapter });
    const rootHandle = await adapter.requestDirectoryAccess();
    const spy = vi.spyOn(contextGeneration, 'generateContext').mockResolvedValue('done');

    await worker({
      ...baseRequest,
      projectTreeUsesViewFilters: false,
      rootDirectoryHandle: rootHandle,
    });

    const call = spy.mock.calls[0];
    expect(call?.[9]).toEqual({ projectTreeUsesViewFilters: false });
  });
});
