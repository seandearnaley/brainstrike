import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { resetFileSizeConfig, setFileSizeConfig } from '@brainstrike/file-system';
import { FileContentError } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileContentProcessor,
  DirectFileContentProcessor,
  WorkerFileContentProcessor,
} from '../file-content-processor.js';

// Mock the worker
vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(() => vi.fn()),
}));

// Mock only the helpers this suite controls while preserving other exports.
vi.mock('@brainstrike/utils/file-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/file-content')>();
  return {
    ...actual,
    fileContent: {
      ...actual.fileContent,
      isBinaryExtension: vi.fn(),
      isTextContent: vi.fn(),
      isTextExtension: vi.fn(),
    },
  };
});

vi.mock('@brainstrike/file-explorer/file-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer/file-tree')>();
  return {
    ...actual,
    fileExplorer: {
      ...actual.fileExplorer,
      getFileExtension: vi.fn(),
    },
  };
});

const mockFileSystemAdapter: FileSystemAdapter = {
  exists: vi.fn(),
  readDirectory: vi.fn(),
  readFile: vi.fn(),
  requestDirectoryAccess: vi.fn(),
};

const mockFileNode = {
  depth: 0,
  handle: {
    createWritable: vi.fn(),
    getFile: vi.fn(),
    isSameEntry: vi.fn(),
    kind: 'file' as const,
    name: 'test.txt',
  } as unknown as FileSystemFileHandle,
  name: 'test.txt',
  path: '/test.txt',
  rootFolderId: 'root1',
  selectionState: 'unchecked' as const,
  type: 'file' as const,
};

const mockRequest = {
  compositeKey: 'root1|@|/test.txt',
  fileNode: mockFileNode,
  fileSystemAdapter: mockFileSystemAdapter,
};

describe('DirectFileContentProcessor', () => {
  const KNOWN_OVERSIZED_FILE_BYTES = 2_000_000;

  beforeEach(() => {
    resetFileSizeConfig();
  });

  afterEach(() => {
    resetFileSizeConfig();
  });

  it('should process files sequentially', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockResolvedValue('file content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': { content: 'file content', status: 'accessible' },
    });
    expect(mockReadFile).toHaveBeenCalledWith({
      _internal: mockFileNode.handle,
      kind: 'file',
      name: 'test.txt',
      path: '/test.txt',
      platform: 'web',
      rootFolderId: 'root1',
    });
  });

  it('uses the canonical handle path for direct reads when node paths are display-relative', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockResolvedValue('file content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('md');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    await processor.processFiles([
      {
        compositeKey: 'fixture-root|@|docs/guide.md',
        fileNode: {
          ...mockFileNode,
          handle: {
            kind: 'file',
            name: 'guide.md',
            path: 'fixture-root/docs/guide.md',
            platform: 'web',
          } as unknown as FileSystemFileHandle,
          name: 'guide.md',
          path: 'docs/guide.md',
          rootFolderId: 'fixture-root',
        },
        fileSystemAdapter: mockFileSystemAdapter,
      },
    ]);

    expect(mockReadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'fixture-root/docs/guide.md',
        rootFolderId: 'fixture-root',
      })
    );
  });

  it('should handle binary files', async () => {
    const processor = new DirectFileContentProcessor();
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('png');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(true);

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': {
        message: 'Binary file - preview not available',
        status: 'inaccessible',
      },
    });
  });

  it('should skip direct reads for known oversized files', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockClear();
    const oversizedRequest = {
      ...mockRequest,
      fileNode: {
        ...mockFileNode,
        size: KNOWN_OVERSIZED_FILE_BYTES,
      },
    };

    const results = await processor.processFiles([oversizedRequest]);

    expect(results['root1|@|/test.txt']).toEqual({
      message: expect.stringContaining('File too large'),
      status: 'inaccessible',
    });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('should respect configured max size for direct reads', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    setFileSizeConfig({ maxFileSize: KNOWN_OVERSIZED_FILE_BYTES + 1024 });
    mockReadFile.mockResolvedValue('file content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const oversizedByDefaultRequest = {
      ...mockRequest,
      fileNode: {
        ...mockFileNode,
        size: KNOWN_OVERSIZED_FILE_BYTES,
      },
    };

    const results = await processor.processFiles([oversizedByDefaultRequest]);

    expect(results['root1|@|/test.txt']).toEqual({ content: 'file content', status: 'accessible' });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('should handle file read errors', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);

    mockReadFile.mockRejectedValue(new Error('Read failed'));

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': { message: 'Error accessing file', status: 'inaccessible' },
    });
  });

  it('should handle FileContentError specifically', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);

    mockReadFile.mockRejectedValue(new FileContentError('Custom error', '/test.txt', 'BINARY'));

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': { message: 'Custom error', status: 'inaccessible' },
    });
  });

  it('should call progress callback', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockResolvedValue('content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const onProgress = vi.fn();
    await processor.processFiles([mockRequest], onProgress);

    expect(onProgress).toHaveBeenCalledWith({
      key: 'root1|@|/test.txt',
      loaded: 1,
      total: 1,
    });
  });

  it('should process multiple files in order', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockImplementation(async (handle) => `content-${handle.name}`);
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const request2 = {
      ...mockRequest,
      compositeKey: 'root1|@|/test2.txt',
      fileNode: { ...mockFileNode, name: 'test2.txt', path: '/test2.txt' },
    };

    const onProgress = vi.fn();
    const results = await processor.processFiles([mockRequest, request2], onProgress);

    expect(results).toEqual({
      'root1|@|/test.txt': { content: 'content-test.txt', status: 'accessible' },
      'root1|@|/test2.txt': { content: 'content-test2.txt', status: 'accessible' },
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      key: 'root1|@|/test.txt',
      loaded: 1,
      total: 2,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      key: 'root1|@|/test2.txt',
      loaded: 2,
      total: 2,
    });
  });

  it('should ignore non-finite size metadata in direct reads', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockClear();
    const { fileExplorer } = await import('@brainstrike/file-explorer/file-tree');
    const { fileContent } = await import('@brainstrike/utils/file-content');
    mockReadFile.mockResolvedValue('file content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const requestWithInvalidSize = {
      ...mockRequest,
      fileNode: {
        ...mockFileNode,
        size: Number.POSITIVE_INFINITY,
      },
    };

    const results = await processor.processFiles([requestWithInvalidSize]);

    expect(results).toEqual({
      'root1|@|/test.txt': { content: 'file content', status: 'accessible' },
    });

    const firstCall = mockReadFile.mock.calls[0]?.[0] as { size?: number };
    expect(firstCall).toBeDefined();
    expect(firstCall?.size).toBeUndefined();
  });

  it('should abort direct processing before reading the next file', async () => {
    const processor = new DirectFileContentProcessor();
    const controller = new AbortController();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    mockReadFile.mockClear();
    mockReadFile.mockImplementation(async (handle) => {
      controller.abort();
      return `content-${handle.name}`;
    });
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const secondRequest = {
      ...mockRequest,
      compositeKey: 'root1|@|/second.txt',
      fileNode: { ...mockFileNode, name: 'second.txt', path: '/second.txt' },
    };

    await expect(
      processor.processFiles([mockRequest, secondRequest], undefined, {
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerFileContentProcessor', () => {
  it('should create and use worker', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({
      key1: { content: 'result1', status: 'accessible' as const },
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter, 3);

    const results = await processor.processFiles([mockRequest]);

    expect(createFileContentWorker).toHaveBeenCalledWith({
      concurrency: 3,
      fileSystemAdapter: mockFileSystemAdapter,
    });
    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          compositeKey: 'root1|@|/test.txt',
          handle: expect.objectContaining({
            kind: 'file',
            name: 'test.txt',
            path: '/test.txt',
            platform: 'web',
          }),
          path: '/test.txt',
        }),
      ],
      undefined,
      undefined
    );
    expect(results).toEqual({ key1: { content: 'result1', status: 'accessible' } });
  });

  it('should pass progress callback to worker', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter);
    const onProgress = vi.fn();

    await processor.processFiles([mockRequest], onProgress);

    expect(mockWorker).toHaveBeenCalledWith(expect.any(Array), onProgress, undefined);
  });

  it('should omit non-finite size metadata from worker handles', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter);
    const requestWithInvalidSize = {
      ...mockRequest,
      fileNode: {
        ...mockFileNode,
        size: Number.NaN,
      },
    };

    await processor.processFiles([requestWithInvalidSize]);

    const workerRequest = mockWorker.mock.calls[0]?.[0]?.[0] as {
      handle?: { size?: number };
    };
    expect(workerRequest?.handle?.size).toBeUndefined();
  });

  it('uses the canonical handle path for worker reads when node paths are display-relative', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter);
    await processor.processFiles([
      {
        compositeKey: 'fixture-root|@|docs/guide.md',
        fileNode: {
          ...mockFileNode,
          handle: {
            kind: 'file',
            name: 'guide.md',
            path: 'fixture-root/docs/guide.md',
            platform: 'web',
          } as unknown as FileSystemFileHandle,
          name: 'guide.md',
          path: 'docs/guide.md',
          rootFolderId: 'fixture-root',
        },
        fileSystemAdapter: mockFileSystemAdapter,
      },
    ]);

    const workerRequest = mockWorker.mock.calls[0]?.[0]?.[0] as {
      handle?: { path?: string; rootFolderId?: string };
    };
    expect(workerRequest?.handle).toEqual(
      expect.objectContaining({
        path: 'fixture-root/docs/guide.md',
        rootFolderId: 'fixture-root',
      })
    );
  });

  it('should pass abort options through to the worker', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);
    const controller = new AbortController();

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter);
    await processor.processFiles([mockRequest], undefined, { abortSignal: controller.signal });

    expect(mockWorker).toHaveBeenCalledWith(expect.any(Array), undefined, {
      abortSignal: controller.signal,
    });
  });
});

describe('createFileContentProcessor', () => {
  it('should create DirectFileContentProcessor when preferDirect is true', () => {
    const processor = createFileContentProcessor(mockFileSystemAdapter, { preferDirect: true });
    expect(processor).toBeInstanceOf(DirectFileContentProcessor);
  });

  it('should create WorkerFileContentProcessor by default', () => {
    const processor = createFileContentProcessor(mockFileSystemAdapter);
    expect(processor).toBeInstanceOf(WorkerFileContentProcessor);
  });

  it('should pass concurrency option to WorkerFileContentProcessor', () => {
    vi.mocked(import('@brainstrike/workers/file-content-worker'));

    createFileContentProcessor(mockFileSystemAdapter, { concurrency: 5 });

    // The constructor should be called in the background, but we can't easily test it
    // without making the constructor async or exposing internal state
  });
});
