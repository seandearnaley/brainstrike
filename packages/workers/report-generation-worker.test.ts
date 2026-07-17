import * as utils from '@brainstrike/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportGenerationWorker } from './report-generation-worker';
import { MockFileSystemAdapter } from './test-helpers';

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

  it('uses adapter version when adapter provided', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker({ fileSystemAdapter: adapter });
    const rootHandle = await adapter.requestDirectoryAccess();
    const spy = vi.spyOn(utils, 'generateContextFromAdapter').mockResolvedValue('report');

    const result = await worker({ ...baseRequest, rootDirectoryHandle: rootHandle });

    expect(spy).toHaveBeenCalled();
    expect(result).toBe('report');
  });

  it('uses web version when no adapter', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker();
    const rootHandle =
      (await adapter.requestDirectoryAccess()) as unknown as FileSystemDirectoryHandle;
    const spy = vi.spyOn(utils, 'generateContext').mockResolvedValue('report');

    const result = await worker({ ...baseRequest, rootDirectoryHandle: rootHandle });

    expect(spy).toHaveBeenCalled();
    expect(result).toBe('report');
  });

  it('emits progress events', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker();
    const rootHandle =
      (await adapter.requestDirectoryAccess()) as unknown as FileSystemDirectoryHandle;
    vi.spyOn(utils, 'generateContext').mockResolvedValue('done');

    const progress: number[] = [];
    await worker({ ...baseRequest, rootDirectoryHandle: rootHandle }, (e) =>
      progress.push(e.loaded)
    );

    expect(progress).toEqual([0, 1]);
  });

  it('passes tapestry and tree filter options when provided', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createReportGenerationWorker();
    const rootHandle =
      (await adapter.requestDirectoryAccess()) as unknown as FileSystemDirectoryHandle;
    const spy = vi.spyOn(utils, 'generateContext').mockResolvedValue('done');

    await worker({
      ...baseRequest,
      projectTreeUsesViewFilters: false,
      rootDirectoryHandle: rootHandle,
      selectedLineRangesByFile: {
        'a.ts': [{ endLine: 1, isActive: true, startLine: 0 }],
      },
    });

    const call = spy.mock.calls[0];
    expect(call?.[8]).toEqual({
      projectTreeUsesViewFilters: false,
      selectedLineRangesByFile: {
        'a.ts': [{ endLine: 1, isActive: true, startLine: 0 }],
      },
    });
  });
});
