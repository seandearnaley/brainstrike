import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import {
  DEFAULT_MAX_FILE_SIZE,
  MockFileSystemAdapter,
  resetFileSizeConfig,
  setFileSizeConfig,
} from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, fileContent, fileExplorer } from '@brainstrike/utils';
import type { FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

// Mock the worker
vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(() => vi.fn()),
}));

function useTestHook(fileTree: IFileNode[]) {
  const store = useFileExplorerStoreContext();
  const loading = useSharedFileContentLoading(fileTree);
  return { store, ...loading };
}

function createWrapper(adapter: MockFileSystemAdapter) {
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

describe('useSharedFileContentLoading - caching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses cached nodes on subsequent loads', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('content');

    const fileNode = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/file.txt');
    const findSpy = vi.spyOn(fileExplorer, 'findNodeByPath').mockReturnValue(fileNode);

    // Setup worker mock to actually call through to adapter
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, string> = {};
          for (const req of requests) {
            try {
              const content = req.handle ? await adapter.readFile(req.handle) : 'No handle';
              results[req.compositeKey] = content;
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch {
              results[req.compositeKey] = 'Error accessing file';
            }
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    // Allow debounced cache rebuild to complete
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0]?.[0]._internal).toBe(fileNode.handle);

    act(() => {
      result.current.store.getState().clearFileContents([compositeKey]);
    });
    rerender();
    findSpy.mockClear();

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(readSpy.mock.calls[1]?.[0]._internal).toBe(fileNode.handle);
  });

  it('refreshes cache when file tree changes', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('content');

    const fileNode1 = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const fileNode2 = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/file.txt');
    const findSpy = vi
      .spyOn(fileExplorer, 'findNodeByPath')
      .mockReturnValueOnce(fileNode1)
      .mockReturnValueOnce(fileNode2);

    // Setup worker mock to actually call through to adapter
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, string> = {};
          for (const req of requests) {
            try {
              const content = req.handle ? await adapter.readFile(req.handle) : 'No handle';
              results[req.compositeKey] = content;
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch {
              results[req.compositeKey] = 'Error accessing file';
            }
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      { wrapper, initialProps: { tree: [fileNode1] } }
    );

    // Allow debounced cache rebuild to complete
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    act(() => {
      result.current.store.getState().clearFileContents([compositeKey]);
    });

    rerender({ tree: [fileNode2] });

    // Allow debounced cache rebuild to complete after tree change
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(readSpy.mock.calls[1]?.[0]._internal).toBe(fileNode2.handle);
  });
});

describe('useSharedFileContentLoading - error handling and loading state', () => {
  it('records per-file error and keeps global error null when readFile throws', async () => {
    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readFile').mockRejectedValue(new Error('boom'));

    const fileNode = createFileNode({ path: '/error.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/error.txt');

    // Setup worker mock to simulate error handling
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(
      vi.fn().mockResolvedValue({ [compositeKey]: 'Error accessing file' })
    );

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
    expect(result.current.error).toBeNull();
  });

  it('handles binary files based on extension', async () => {
    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readFile').mockResolvedValue('binary');
    vi.spyOn(fileContent, 'isBinaryExtension').mockReturnValue(true);

    const fileNode = createFileNode({ path: '/image.png', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/image.png');

    // Setup worker mock to simulate binary file handling
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(
      vi.fn().mockResolvedValue({ [compositeKey]: 'Binary file - preview not available' })
    );

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe('Binary file - preview not available');
  });

  it('updates loadingFiles for concurrent loads', async () => {
    const adapter = new MockFileSystemAdapter();
    const resolvers: Array<() => void> = [];
    vi.spyOn(adapter, 'readFile').mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(() => resolve('done')))
    );

    const fileNode1 = createFileNode({ path: '/one.txt', rootFolderId: 'root1' });
    const fileNode2 = createFileNode({ path: '/two.txt', rootFolderId: 'root1' });
    const key1 = encodeFileSelection('root1', '/one.txt');
    const key2 = encodeFileSelection('root1', '/two.txt');

    // Setup worker mock to properly simulate async loading with progress callbacks
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const processRequest = async (
      req: FileReadRequest,
      progressCallback?: (event: { key: string }) => void
    ) => {
      try {
        const content = req.handle ? await adapter.readFile(req.handle) : 'No handle';
        if (progressCallback) {
          progressCallback({ key: req.compositeKey });
        }
        return content;
      } catch {
        if (progressCallback) {
          progressCallback({ key: req.compositeKey });
        }
        return 'Error accessing file';
      }
    };

    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, string> = {};

          // Process each request and wait for its resolver
          for (const req of requests) {
            results[req.compositeKey] = await processRequest(req, progressCallback);
          }

          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([fileNode1, fileNode2]), { wrapper });

    // Start loading
    let loadingPromise: Promise<void>;
    act(() => {
      loadingPromise = result.current.handleFileContentLoading([key1, key2]);
    });

    // Check that files are initially in loading state
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loadingFiles.has(key1)).toBe(true);
    expect(result.current.loadingFiles.has(key2)).toBe(true);

    // Resolve first file
    resolvers.shift()?.();
    await act(async () => {
      await Promise.resolve();
    });

    // Resolve second file
    resolvers.shift()?.();

    // Wait for loading to complete
    await act(async () => {
      await loadingPromise;
    });

    expect(result.current.loadingFiles.size).toBe(0);
  });
});

describe('useSharedFileContentLoading - additional edge cases', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetFileSizeConfig();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(fileContent, 'isBinaryExtension').mockReturnValue(false);
    // Re-establish worker mock after restoreAllMocks
    const { createFileContentWorker } = vi.mocked(
      await import('@brainstrike/workers/file-content-worker')
    );
    createFileContentWorker.mockReturnValue(vi.fn().mockResolvedValue({}));
  });
  it('handles folder mismatch errors', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('content');

    const fileNode = createFileNode({ path: '/mismatch.txt', rootFolderId: 'root2' });
    const compositeKey = encodeFileSelection('root1', '/mismatch.txt');

    vi.spyOn(fileExplorer, 'findNodeByPath').mockReturnValue(fileNode);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(readSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toMatch('Folder mismatch');
  });

  it('skips oversized files before queueing worker reads', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/too-large.txt', rootFolderId: 'root1' });
    fileNode.size = DEFAULT_MAX_FILE_SIZE + 1;
    const compositeKey = encodeFileSelection('root1', '/too-large.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toMatch('File too large');
    expect(mockWorker).toHaveBeenCalledWith([], expect.any(Function));
  });

  it('respects configured max file size when pre-checking known sizes', async () => {
    setFileSizeConfig({ maxFileSize: DEFAULT_MAX_FILE_SIZE * 2 });

    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({
      path: '/within-configured-limit.txt',
      rootFolderId: 'root1',
    });
    fileNode.size = DEFAULT_MAX_FILE_SIZE + 1;
    const compositeKey = encodeFileSelection('root1', '/within-configured-limit.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({ [compositeKey]: 'loaded' });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe('loaded');
    expect(result.current.fileContents[compositeKey]).not.toMatch('File too large');
    expect(mockWorker).toHaveBeenCalledWith(
      [expect.objectContaining({ compositeKey })],
      expect.any(Function)
    );
  });

  it('omits non-finite file sizes when creating worker handles', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/nan-size.txt', rootFolderId: 'root1' });
    fileNode.size = Number.NaN;
    const compositeKey = encodeFileSelection('root1', '/nan-size.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({ [compositeKey]: 'loaded' });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    const firstRequest = mockWorker.mock.calls[0]?.[0]?.[0] as {
      handle?: { size?: number };
    };
    expect(firstRequest).toBeDefined();
    expect(firstRequest?.handle?.size).toBeUndefined();
    expect(result.current.fileContents[compositeKey]).toBe('loaded');
  });

  it('retries when handle is missing on first lookup', async () => {
    const adapter = new MockFileSystemAdapter();

    const withHandle = createFileNode({ path: '/retry.txt', rootFolderId: 'root1' });
    const withoutHandle = { ...withHandle, handle: undefined as unknown as FileSystemFileHandle };
    const compositeKey = encodeFileSelection('root1', '/retry.txt');

    const findSpy = vi.spyOn(fileExplorer, 'findNodeByPath').mockReturnValue(withHandle);

    // Setup worker mock
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(
      vi.fn().mockResolvedValue({ [compositeKey]: 'retry' })
    );

    vi.useFakeTimers();

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([withoutHandle]), { wrapper });

    await act(async () => {
      const promise = result.current.handleFileContentLoading([compositeKey]);
      vi.advanceTimersByTime(100);
      await promise;
      rerender();
    });

    vi.useRealTimers();

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(result.current.fileContents[compositeKey]).toBe('retry');
  });

  it('limits concurrent loading to MAX_CONCURRENT_LOADS', async () => {
    const adapter = new MockFileSystemAdapter();

    const MaxConcurrentLoads = 20;
    const total = MaxConcurrentLoads + 5;
    const nodes: IFileNode[] = [];
    const keys: string[] = [];
    const results: Record<string, string> = {};

    for (let i = 0; i < total; i++) {
      const node = createFileNode({ path: `/file${i}.txt`, rootFolderId: 'root1' });
      nodes.push(node);
      const key = encodeFileSelection('root1', node.path);
      keys.push(key);
      results[key] = `content-${i}`;
    }

    // Setup worker mock to handle all files
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          // Simulate progress for each request
          requests.forEach((req, _index) => {
            if (progressCallback) {
              progressCallback({ key: req.compositeKey });
            }
          });
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook(nodes), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading(keys);
    });

    // All files should be loaded
    expect(Object.keys(result.current.fileContents)).toHaveLength(total);
    expect(result.current.loadingFiles.size).toBe(0);
  });

  it('handles empty input gracefully', async () => {
    const adapter = new MockFileSystemAdapter();

    // Setup worker mock for empty input
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(vi.fn().mockResolvedValue({}));

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([]);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingFiles.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('defers direct-path reads until the tree is initialized', async () => {
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn()
      .mockResolvedValue('deferred-content') as unknown as MockFileSystemAdapter['readFile'];
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;

    const compositeKey = encodeFileSelection('root1', '/deferred.txt');
    const fileNode = createFileNode({ path: '/deferred.txt', rootFolderId: 'root1' });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({ [compositeKey]: 'deferred-content' });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      {
        wrapper,
        initialProps: { tree: [] as IFileNode[] },
      }
    );

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(mockWorker).not.toHaveBeenCalled();
    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBeUndefined();

    await act(async () => {
      rerender({ tree: [fileNode] });
      await Promise.resolve();
    });

    expect(mockWorker).toHaveBeenCalledWith(
      [expect.objectContaining({ compositeKey })],
      expect.any(Function)
    );
    expect(result.current.fileContents[compositeKey]).toBe('deferred-content');
  });

  it('defers restored Electron tab loads until the file enters the tree', async () => {
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn()
      .mockResolvedValue('should-not-be-used') as unknown as MockFileSystemAdapter['readFile'];
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;

    const otherNode = createFileNode({ path: '/other.txt', rootFolderId: 'root1' });
    const fileNode = createFileNode({ path: '/restored.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/restored.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockImplementation(async (requests: FileReadRequest[]) => {
      if (requests.length === 0) {
        return {};
      }
      return { [compositeKey]: 'restored-content' };
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      {
        wrapper,
        initialProps: { tree: [otherNode] },
      }
    );

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(mockWorker).toHaveBeenCalledWith([], expect.any(Function));
    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBeUndefined();

    await act(async () => {
      rerender({ tree: [otherNode, fileNode] });
      await Promise.resolve();
    });

    expect(mockWorker).toHaveBeenCalledWith(
      [expect.objectContaining({ compositeKey })],
      expect.any(Function)
    );
    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBe('restored-content');
  });

  it('reads selected absolute-root files by path when lazy tree children are not indexed yet', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue('agent-selected-content');
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;

    const rootFolderId = '/workspace/root';
    const compositeKey = encodeFileSelection(rootFolderId, '/src/dynamic.ts');
    const otherNode = createFileNode({ path: '/other.txt', rootFolderId });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, string> = {};
          for (const request of requests) {
            results[request.compositeKey] = request.handle
              ? await adapter.readFile(request.handle)
              : await readFileByPathSpy(request.path);
            progressCallback?.({ key: request.compositeKey });
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([otherNode]), { wrapper });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey]);
      vi.advanceTimersByTime(100);
      await loadPromise;
    });

    expect(mockWorker).toHaveBeenCalledWith(
      [expect.objectContaining({ compositeKey, path: '/workspace/root/src/dynamic.ts' })],
      expect.any(Function)
    );
    expect(readFileByPathSpy).toHaveBeenCalledWith('/workspace/root/src/dynamic.ts');
    expect(result.current.fileContents[compositeKey]).toBe('agent-selected-content');
    expect(result.current.loadingFiles.size).toBe(0);
  });

  it('fails explicitly instead of falling back to direct-path reads when the tree never contains the file', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn()
      .mockResolvedValue('should-not-be-used') as unknown as MockFileSystemAdapter['readFile'];
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;

    const compositeKey = encodeFileSelection('root1', '/missing.txt');
    const fileNode = createFileNode({ path: '/other.txt', rootFolderId: 'root1' });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      {
        wrapper,
        initialProps: { tree: [fileNode] },
      }
    );

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey]);
      vi.advanceTimersByTime(100);
      await loadPromise;
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nextTree = Array.from({ length: attempt + 2 }, (_, index) =>
        createFileNode({ path: `/other-${index}.txt`, rootFolderId: 'root1' })
      );

      await act(async () => {
        rerender({ tree: nextTree });
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
    }

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(mockWorker).toHaveBeenLastCalledWith([], expect.any(Function));
    expect(result.current.fileContents[compositeKey]).toBe(
      'File not found in file tree: /missing.txt'
    );
    vi.useRealTimers();
  });
});
