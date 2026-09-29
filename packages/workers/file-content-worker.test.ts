import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  DEFAULT_MAX_FILE_SIZE,
  resetFileSizeConfig,
  setFileSizeConfig,
} from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import type { FileHandle } from '@brainstrike/types';
import * as utils from '@brainstrike/utils';
import { fileContent } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileContentWorker,
  type FileContentReadResult,
  type ProgressEvent as FileProgressEvent,
} from './file-content-worker';
import { MockFileSystemAdapter } from './test-helpers';

function displayResult(result: FileContentReadResult | undefined): string {
  if (!result) {
    throw new Error('Expected a file content result.');
  }
  return result.status === 'accessible' ? result.content : result.message;
}

vi.spyOn(console, 'error').mockImplementation(() => {});

function createRequest(path: string) {
  const node = createFileNode({ path });
  const handle: FileHandle = {
    _internal: node.handle,
    kind: 'file',
    name: node.name,
    path: node.path,
    platform: 'web',
  };

  if (typeof node.size === 'number') {
    handle.size = node.size;
  }

  return {
    compositeKey: `root|@|${path}`,
    handle,
    path,
  };
}

describe('file-content-worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockFileSystemAdapter.clearMockData();
    resetFileSizeConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockFileSystemAdapter.clearMockData();
    resetFileSizeConfig();
  });
  it('reads text files', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/file.txt');
    MockFileSystemAdapter.setMockFileContent('/file.txt', 'hello');

    const results = await worker([req]);
    expect(results[req.compositeKey]).toEqual({ content: 'hello', status: 'accessible' });
  });

  it('prefers handle-based reads when a handle is available', async () => {
    const readFile = vi.fn(async () => 'from-handle');
    const readFileByPath = vi.fn(async () => 'from-path');
    const adapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(),
      readFile,
      readFileByPath,
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/prefers-handle.txt');
    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('from-handle');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFileByPath).not.toHaveBeenCalled();
  });

  it('uses the explicit root-confined capability for an absolute path request', async () => {
    const readFileByAbsolutePath = vi.fn(async () => 'from-absolute-path');
    const readFileByPath = vi.fn(async () => 'from-adapter-path');
    const adapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      readFileByAbsolutePath,
      readFileByPath,
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;
    const request = {
      absoluteRootId: 'root-workspace',
      absoluteRootPath: '/workspace',
      compositeKey: 'root|@|/workspace/file.txt',
      path: '/workspace/file.txt',
    };

    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const results = await worker([request]);

    expect(displayResult(results[request.compositeKey])).toBe('from-absolute-path');
    expect(readFileByAbsolutePath).toHaveBeenCalledExactlyOnceWith(
      '/workspace/file.txt',
      '/workspace',
      'root-workspace'
    );
    expect(readFileByPath).not.toHaveBeenCalled();
  });

  it.each([
    { absoluteRootPath: 'C:\\Workspace', path: 'C:\\Workspace\\file.txt' },
    {
      absoluteRootPath: '\\\\server\\share',
      path: '\\\\server\\share\\file.txt',
    },
  ])(
    'preserves drive and UNC explicit read shapes root=$absoluteRootPath',
    async ({ absoluteRootPath, path }) => {
      const readFileByAbsolutePath = vi.fn(async () => 'cross-platform-content');
      const adapter = {
        exists: vi.fn(),
        readDirectory: vi.fn(),
        readFile: vi.fn(),
        readFileByAbsolutePath,
        requestDirectoryAccess: vi.fn(),
      } as unknown as FileSystemAdapter;
      const request = {
        absoluteRootId: 'root-cross-platform',
        absoluteRootPath,
        compositeKey: `root|@|${path}`,
        path,
      };

      const worker = createFileContentWorker({ fileSystemAdapter: adapter });
      const results = await worker([request]);

      expect(displayResult(results[request.compositeKey])).toBe('cross-platform-content');
      expect(readFileByAbsolutePath).toHaveBeenCalledExactlyOnceWith(
        path,
        absoluteRootPath,
        'root-cross-platform'
      );
    }
  );

  it.each([
    { absoluteRootPath: '', path: '/workspace/file.txt' },
    { absoluteRootPath: '   ', path: '/workspace/file.txt' },
    { absoluteRootPath: 'workspace', path: '/workspace/file.txt' },
    { absoluteRootPath: '\\workspace', path: '/workspace/file.txt' },
    { absoluteRootPath: '/workspace', path: 'file.txt' },
    { absoluteRootPath: '/workspace', path: '\\file.txt' },
  ])(
    'rejects malformed explicit read authority root=$absoluteRootPath path=$path',
    async ({ absoluteRootPath, path }) => {
      const readFileByAbsolutePath = vi.fn(async () => 'unsafe-content');
      const readFileByPath = vi.fn(async () => 'unsafe-fallback-content');
      const adapter = {
        exists: vi.fn(),
        readDirectory: vi.fn(),
        readFile: vi.fn(),
        readFileByAbsolutePath,
        readFileByPath,
        requestDirectoryAccess: vi.fn(),
      } as unknown as FileSystemAdapter;
      const request = {
        absoluteRootId: 'root-workspace',
        absoluteRootPath,
        compositeKey: 'root|@|malformed-file.txt',
        path,
      };

      const worker = createFileContentWorker({ fileSystemAdapter: adapter });
      const results = await worker([request]);

      expect(results[request.compositeKey]).toEqual({
        message: 'Error accessing file',
        status: 'inaccessible',
      });
      expect(readFileByAbsolutePath).not.toHaveBeenCalled();
      expect(readFileByPath).not.toHaveBeenCalled();
    }
  );

  it('rejects an absolute request without durable root identity and never falls back', async () => {
    const readFileByAbsolutePath = vi.fn(async () => 'unsafe-content');
    const readFileByPath = vi.fn(async () => 'unsafe-fallback-content');
    const adapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      readFileByAbsolutePath,
      readFileByPath,
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;
    const request = {
      absoluteRootPath: '/workspace',
      compositeKey: 'root-workspace|@|/workspace/file.txt',
      path: '/workspace/file.txt',
    };

    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const results = await worker([request]);

    expect(results[request.compositeKey]).toEqual({
      message: 'Error accessing file',
      status: 'inaccessible',
    });
    expect(readFileByAbsolutePath).not.toHaveBeenCalled();
    expect(readFileByPath).not.toHaveBeenCalled();
  });

  it('does not fall back to adapter-defined path reads for an absolute request', async () => {
    const readFileByPath = vi.fn(async () => 'unsafe-fallback-content');
    const adapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      readFileByPath,
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;
    const request = {
      absoluteRootId: 'root-workspace',
      absoluteRootPath: '/workspace',
      compositeKey: 'root|@|/workspace/file.txt',
      path: '/workspace/file.txt',
    };

    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const results = await worker([request]);

    expect(results[request.compositeKey]).toEqual({
      message: 'Error accessing file',
      status: 'inaccessible',
    });
    expect(readFileByPath).not.toHaveBeenCalled();
  });

  it('skips known oversized files before adapter reads are attempted', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile');
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/large.txt');
    req.handle.size = DEFAULT_MAX_FILE_SIZE + 1;

    const results = await worker([req]);

    expect(results[req.compositeKey]).toEqual({
      message: expect.stringContaining('File too large'),
      status: 'inaccessible',
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('respects runtime file-size config when maxFileSize option is not provided', async () => {
    setFileSizeConfig({ maxFileSize: DEFAULT_MAX_FILE_SIZE * 2 });

    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile');
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/within-configured-limit.txt');
    req.handle.size = DEFAULT_MAX_FILE_SIZE + 1;
    MockFileSystemAdapter.setMockFileContent(
      '/within-configured-limit.txt',
      'configured-limit-content'
    );

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('configured-limit-content');
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('returns binary error for binary extension', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/image.png');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(true);

    const results = await worker([req]);
    expect(results[req.compositeKey]).toEqual({
      message: expect.stringContaining('Binary file'),
      status: 'inaccessible',
    });
  });

  it('returns binary error when content is not text', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/unknown.bin');
    MockFileSystemAdapter.setMockFileContent('/unknown.bin', 'binary');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(false);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(false);

    const results = await worker([req]);
    expect(displayResult(results[req.compositeKey])).toMatch('Binary file');
  });

  it('processes queued reads with concurrency limit', async () => {
    class DelayedAdapter extends MockFileSystemAdapter {
      active = 0;
      maxActive = 0;
      constructor(private readonly delays: Record<string, number>) {
        super();
      }
      override async readFile(handle: Parameters<MockFileSystemAdapter['readFile']>[0]) {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        const path = handle.path || handle.name;
        const delay = this.delays[path] ?? 0;
        await new Promise((r) => setTimeout(r, delay));
        const content = await super.readFile(handle);
        this.active -= 1;
        return content;
      }
    }

    const delays = {
      '/1.txt': 50,
      '/2.txt': 50,
      '/3.txt': 10,
      '/4.txt': 10,
    };
    const adapter = new DelayedAdapter(delays);
    for (const p of Object.keys(delays)) {
      MockFileSystemAdapter.setMockFileContent(p, p.slice(1));
    }
    const worker = createFileContentWorker({
      concurrency: 2,
      fileSystemAdapter: adapter,
    });
    const requests = Object.keys(delays).map((p) => createRequest(p));
    const progress: number[] = [];

    // Use fake timers to deterministically flush the delayed reads
    vi.useFakeTimers();
    const promise = worker(requests, (e) => progress.push(e.loaded));
    await vi.runAllTimersAsync();
    const results = await promise;
    vi.useRealTimers();

    expect(displayResult(results['root|@|/1.txt'])).toBe('1.txt');
    expect(displayResult(results['root|@|/2.txt'])).toBe('2.txt');
    expect(displayResult(results['root|@|/3.txt'])).toBe('3.txt');
    expect(displayResult(results['root|@|/4.txt'])).toBe('4.txt');
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(adapter.maxActive).toBeLessThanOrEqual(2);
  });

  it('aborts before scheduling additional queued reads', async () => {
    class AbortableAdapter extends MockFileSystemAdapter {
      override async readFile(handle: Parameters<MockFileSystemAdapter['readFile']>[0]) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return super.readFile(handle);
      }
    }

    const adapter = new AbortableAdapter();
    MockFileSystemAdapter.setMockFileContent('/1.txt', '1');
    MockFileSystemAdapter.setMockFileContent('/2.txt', '2');
    const worker = createFileContentWorker({ concurrency: 1, fileSystemAdapter: adapter });
    const controller = new AbortController();

    vi.useFakeTimers();
    const promise = worker([createRequest('/1.txt'), createRequest('/2.txt')], undefined, {
      abortSignal: controller.signal,
    });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    await rejection;
  });

  it('returns loading error when readFile rejects', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/fail.txt');
    MockFileSystemAdapter.setMockReadFileError('/fail.txt', new Error('fail'));

    const results = await worker([req]);

    expect(results[req.compositeKey]).toEqual({
      message: 'Error accessing file',
      status: 'inaccessible',
    });
  });

  it('maps structured TOO_LARGE errors from adapter reads', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/too-large.txt');
    const oversizedError = Object.assign(new Error('File exceeds preview size limit'), {
      code: 'TOO_LARGE' as const,
    });

    MockFileSystemAdapter.setMockReadFileError('/too-large.txt', oversizedError);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('File exceeds preview size limit');
  });

  it('maps non-Error TOO_LARGE objects from adapter reads', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/too-large-object.txt');
    const oversizedError = {
      code: 'TOO_LARGE' as const,
      message: 'Object-based too large error',
    };

    MockFileSystemAdapter.setMockReadFileError(
      '/too-large-object.txt',
      oversizedError as unknown as Error
    );

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('Object-based too large error');
  });

  it('reports progress for failed files', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const successReq = createRequest('/good.txt');
    const failReq = createRequest('/bad.txt');
    MockFileSystemAdapter.setMockFileContent('/good.txt', 'ok');
    MockFileSystemAdapter.setMockReadFileError('/bad.txt', new Error('fail'));

    const progress: number[] = [];
    const results = await worker([successReq, failReq], (e) => progress.push(e.loaded));

    expect(progress).toEqual([1, 2]);
    expect(displayResult(results[successReq.compositeKey])).toBe('ok');
    expect(displayResult(results[failReq.compositeKey])).toMatch('Error accessing file');
  });

  it('rejects when the progress finalizer throws instead of leaving the queue promise pending', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const request = createRequest('/progress-failure.txt');
    const schedulerFailure = new Error('progress finalizer failed');
    let progressCalls = 0;

    MockFileSystemAdapter.setMockFileContent(request.path, 'content');

    const queuePromise = worker([request], () => {
      progressCalls += 1;
      if (progressCalls === 1) {
        throw schedulerFailure;
      }
    });

    await expect(queuePromise).rejects.toBe(schedulerFailure);
    expect(progressCalls).toBe(1);
  }, 1000);

  it('rejects concurrent completions when the first progress finalizer throws', async () => {
    let releaseReads: () => void = () => {
      throw new Error('Read barrier was not initialized');
    };
    const readBarrier = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reportBothReadsStarted: () => void = () => {
      throw new Error('Read-start barrier was not initialized');
    };
    const bothReadsStarted = new Promise<void>((resolve) => {
      reportBothReadsStarted = resolve;
    });

    class BarrierAdapter extends MockFileSystemAdapter {
      private readsStarted = 0;

      override async readFile(handle: Parameters<MockFileSystemAdapter['readFile']>[0]) {
        this.readsStarted += 1;
        if (this.readsStarted === 2) {
          reportBothReadsStarted();
        }
        await readBarrier;
        return super.readFile(handle);
      }
    }

    const adapter = new BarrierAdapter();
    const worker = createFileContentWorker({ concurrency: 2, fileSystemAdapter: adapter });
    const firstRequest = createRequest('/concurrent-first.txt');
    const secondRequest = createRequest('/concurrent-second.txt');
    const schedulerFailure = new Error('first progress finalizer failed');
    let progressCalls = 0;

    MockFileSystemAdapter.setMockFileContent(firstRequest.path, 'first');
    MockFileSystemAdapter.setMockFileContent(secondRequest.path, 'second');

    const queuePromise = worker([firstRequest, secondRequest], () => {
      progressCalls += 1;
      if (progressCalls === 1) {
        throw schedulerFailure;
      }
    });

    await bothReadsStarted;
    releaseReads();

    await expect(queuePromise).rejects.toBe(schedulerFailure);
    expect(progressCalls).toBe(1);
  }, 1000);

  it('handles empty request queue immediately', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });

    const results = await worker([]);

    expect(results).toEqual({});
  });

  it('validates error contains specific error message for FileContentError', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/fail.txt');
    MockFileSystemAdapter.setMockReadFileError('/fail.txt', new Error('disk failure'));

    const results = await worker([req]);

    // The error should be the generic message, not the original error message
    expect(displayResult(results[req.compositeKey])).toBe('Error accessing file');
    expect(displayResult(results[req.compositeKey])).not.toContain('disk failure');
  });

  it('rejects text extension file with binary content', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/fake.txt');
    MockFileSystemAdapter.setMockFileContent('/fake.txt', 'binary-data');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(true);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(false);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toMatch('Binary file - preview not available');
    expect(utils.isTextExtension).toHaveBeenCalledWith('txt');
    expect(fileContent.isTextContent).toHaveBeenCalledWith('binary-data');
  });

  it('rejects text extension files with null bytes beyond the initial sample', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/late-null.txt');
    MockFileSystemAdapter.setMockFileContent(
      '/late-null.txt',
      `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`
    );
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(true);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toMatch('Binary file - preview not available');
  });

  it('accepts unknown extension file with text content', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/file.xyz');
    MockFileSystemAdapter.setMockFileContent('/file.xyz', 'text content');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(false);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(true);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('text content');
    expect(fileContent.isTextContent).toHaveBeenCalledWith('text content');
  });

  it('rejects unknown extension file with binary content', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/file.xyz');
    MockFileSystemAdapter.setMockFileContent('/file.xyz', 'binary-data');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(false);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(false);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toMatch('Binary file - preview not available');
    expect(fileContent.isTextContent).toHaveBeenCalledWith('binary-data');
  });

  it('completes all requests even with mixed successes and failures', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ concurrency: 1, fileSystemAdapter: adapter });
    const req1 = createRequest('/file1.txt');
    const req2 = createRequest('/file2.txt');
    const req3 = createRequest('/file3.txt');
    MockFileSystemAdapter.setMockFileContent('/file1.txt', 'content1');
    MockFileSystemAdapter.setMockReadFileError('/file2.txt', new Error('fail'));
    MockFileSystemAdapter.setMockFileContent('/file3.txt', 'content3');

    const progress: FileProgressEvent[] = [];
    const results = await worker([req1, req2, req3], (e) => progress.push(e));

    // Verify all three files were processed
    expect(Object.keys(results)).toHaveLength(3);
    expect(displayResult(results[req1.compositeKey])).toBe('content1');
    expect(displayResult(results[req2.compositeKey])).toMatch('Error accessing file');
    expect(displayResult(results[req3.compositeKey])).toBe('content3');
    // Verify progress tracked all completions
    expect(progress).toHaveLength(3);
    expect(progress.map((p) => p.loaded)).toEqual([1, 2, 3]);
    expect(progress.every((p) => p.total === 3)).toBe(true);
  });

  it('handles text extension file with text content successfully', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/document.txt');
    MockFileSystemAdapter.setMockFileContent('/document.txt', 'This is text content');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(utils, 'isTextExtension').mockReturnValue(true);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(true);

    const results = await worker([req]);

    expect(displayResult(results[req.compositeKey])).toBe('This is text content');
    expect(fileContent.isTextContent).toHaveBeenCalledWith('This is text content');
  });

  it('uses custom concurrency setting', async () => {
    class ConcurrencyTracker extends MockFileSystemAdapter {
      active = 0;
      maxActive = 0;

      override async readFile(handle: Parameters<MockFileSystemAdapter['readFile']>[0]) {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((r) => setTimeout(r, 10));
        const result = await super.readFile(handle);
        this.active -= 1;
        return result;
      }
    }

    const adapter = new ConcurrencyTracker();
    const worker = createFileContentWorker({ concurrency: 3, fileSystemAdapter: adapter });
    const requests = ['/1.txt', '/2.txt', '/3.txt', '/4.txt', '/5.txt'].map(createRequest);
    requests.forEach((req) => {
      MockFileSystemAdapter.setMockFileContent(req.path, `content-${req.path}`);
    });

    vi.useFakeTimers();
    const promise = worker(requests);
    await vi.runAllTimersAsync();
    const results = await promise;
    vi.useRealTimers();

    expect(Object.keys(results)).toHaveLength(5);
    expect(adapter.maxActive).toBeLessThanOrEqual(3);
  });
});
