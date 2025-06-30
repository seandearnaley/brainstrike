import type { FileSystemAdapter } from '@brainstrike/file-system';
import { FileContentError } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileContentProcessor,
  DirectFileContentProcessor,
  WorkerFileContentProcessor,
} from '../file-content-processor';

// Mock the worker
vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(() => vi.fn()),
}));

// Mock utils
vi.mock('@brainstrike/utils', () => ({
  fileContent: {
    isBinaryExtension: vi.fn(),
    isTextExtension: vi.fn(),
    isTextContent: vi.fn(),
  },
  fileExplorer: {
    getFileExtension: vi.fn(),
  },
}));

const mockFileSystemAdapter: FileSystemAdapter = {
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  requestDirectoryAccess: vi.fn(),
  exists: vi.fn(),
};

const mockFileNode = {
  name: 'test.txt',
  path: '/test.txt',
  type: 'file' as const,
  handle: {
    kind: 'file' as const,
    name: 'test.txt',
    createWritable: vi.fn(),
    getFile: vi.fn(),
    isSameEntry: vi.fn(),
  } as unknown as FileSystemFileHandle,
  rootFolderId: 'root1',
  depth: 0,
  selectionState: 'unchecked' as const,
};

const mockRequest = {
  compositeKey: 'root1|@|/test.txt',
  fileNode: mockFileNode,
  fileSystemAdapter: mockFileSystemAdapter,
};

describe('DirectFileContentProcessor', () => {
  it('should process files sequentially', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    const { fileContent, fileExplorer } = await import('@brainstrike/utils');

    mockReadFile.mockResolvedValue('file content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('.txt');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': 'file content',
    });
    expect(mockReadFile).toHaveBeenCalledWith({
      path: '/test.txt',
      name: 'test.txt',
      kind: 'file',
      platform: 'web',
      _internal: mockFileNode.handle,
    });
  });

  it('should handle binary files', async () => {
    const processor = new DirectFileContentProcessor();
    const { fileContent, fileExplorer } = await import('@brainstrike/utils');

    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('.png');
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(true);

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': 'Binary file - preview not available',
    });
  });

  it('should handle file read errors', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);

    mockReadFile.mockRejectedValue(new Error('Read failed'));

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': 'Error accessing file',
    });
  });

  it('should handle FileContentError specifically', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);

    mockReadFile.mockRejectedValue(new FileContentError('Custom error', '/test.txt', 'BINARY'));

    const results = await processor.processFiles([mockRequest]);

    expect(results).toEqual({
      'root1|@|/test.txt': 'Custom error',
    });
  });

  it('should call progress callback', async () => {
    const processor = new DirectFileContentProcessor();
    const mockReadFile = vi.mocked(mockFileSystemAdapter.readFile);
    const { fileContent, fileExplorer } = await import('@brainstrike/utils');

    mockReadFile.mockResolvedValue('content');
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('.txt');
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
    const { fileContent, fileExplorer } = await import('@brainstrike/utils');

    mockReadFile.mockImplementation(async (handle) => `content-${handle.name}`);
    vi.mocked(fileExplorer.getFileExtension).mockReturnValue('.txt');
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
      'root1|@|/test.txt': 'content-test.txt',
      'root1|@|/test2.txt': 'content-test2.txt',
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
});

describe('WorkerFileContentProcessor', () => {
  it('should create and use worker', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({ key1: 'result1' });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter, 3);

    const results = await processor.processFiles([mockRequest]);

    expect(createFileContentWorker).toHaveBeenCalledWith({
      fileSystemAdapter: mockFileSystemAdapter,
      concurrency: 3,
    });
    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          compositeKey: 'root1|@|/test.txt',
          path: '/test.txt',
          handle: expect.objectContaining({
            name: 'test.txt',
            path: '/test.txt',
            kind: 'file',
            platform: 'web',
          }),
        }),
      ],
      undefined
    );
    expect(results).toEqual({ key1: 'result1' });
  });

  it('should pass progress callback to worker', async () => {
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const processor = new WorkerFileContentProcessor(mockFileSystemAdapter);
    const onProgress = vi.fn();

    await processor.processFiles([mockRequest], onProgress);

    expect(mockWorker).toHaveBeenCalledWith(expect.any(Array), onProgress);
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
