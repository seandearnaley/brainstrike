import { createFileNode } from '@brainstrike/test-utils';
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
    vi.spyOn(fileContent, 'isBinaryExtension').mockReturnValue(true);

    const results = await worker([req]);
    expect(results[req.compositeKey]).toMatch('Binary file');
  });

  it('returns binary error when content is not text', async () => {
    const adapter = new MockFileSystemAdapter();
    const worker = createFileContentWorker({ fileSystemAdapter: adapter });
    const req = createRequest('/unknown.bin');
    MockFileSystemAdapter.setMockFileContent('/unknown.bin', 'binary');
    vi.spyOn(fileContent, 'isBinaryExtension').mockReturnValue(false);
    vi.spyOn(fileContent, 'isTextExtension').mockReturnValue(false);
    vi.spyOn(fileContent, 'isTextContent').mockReturnValue(false);

    const results = await worker([req]);
    expect(results[req.compositeKey]).toMatch('Binary file');
  });
});
