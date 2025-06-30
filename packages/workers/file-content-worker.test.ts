import { createFileNode } from '@brainstrike/test-utils';
import * as utils from '@brainstrike/utils';
import { fileContent } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileContentWorker } from './file-content-worker';
import { MockFileSystemAdapter } from './test-helpers';

vi.spyOn(console, 'error').mockImplementation(() => {});

function createRequest(path: string) {
  const node = createFileNode({ path });
  return {
    compositeKey: `root|@|${path}`,
    path,
    handle: {
      path: node.path,
      name: node.name,
      kind: 'file' as const,
      platform: 'web' as const,
      _internal: node.handle,
    },
  };
}

describe('file-content-worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockFileSystemAdapter.clearMockData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockFileSystemAdapter.clearMockData();
  });
  it('reads text files', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/file.txt');
    MockFileSystemAdapter.setMockFileContent('/file.txt', 'hello');

    const results = await worker([req]);
    expect(results[req.compositeKey]).toBe('hello');
  });

  it('returns binary error for binary extension', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/image.png');
    vi.spyOn(utils, 'isBinaryExtension').mockReturnValue(true);

    const results = await worker([req]);
    expect(results[req.compositeKey]).toMatch('Binary file');
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
    expect(results[req.compositeKey]).toMatch('Binary file');
  });

  it('processes queued reads with concurrency limit', async () => {
    class DelayedAdapter extends MockFileSystemAdapter {
      active = 0;
      maxActive = 0;
      constructor(private delays: Record<string, number>) {
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
    Object.keys(delays).forEach((p) => MockFileSystemAdapter.setMockFileContent(p, p.slice(1)));
    const worker = createFileContentWorker({
      fileSystemAdapter: adapter,
      concurrency: 2,
    });
    const requests = Object.keys(delays).map((p) => createRequest(p));
    const progress: number[] = [];

    const results = await worker(requests, (e) => progress.push(e.loaded));

    expect(results['root|@|/1.txt']).toBe('1.txt');
    expect(results['root|@|/2.txt']).toBe('2.txt');
    expect(results['root|@|/3.txt']).toBe('3.txt');
    expect(results['root|@|/4.txt']).toBe('4.txt');
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(adapter.maxActive).toBeLessThanOrEqual(2);
  });

  it('returns loading error when readFile rejects', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/fail.txt');
    MockFileSystemAdapter.setMockReadFileError('/fail.txt', new Error('fail'));

    const results = await worker([req]);

    expect(results[req.compositeKey]).toMatch('Error accessing file');
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
    expect(results[successReq.compositeKey]).toBe('ok');
    expect(results[failReq.compositeKey]).toMatch('Error accessing file');
  });
});
