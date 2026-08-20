import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider, INACCESSIBLE_CONTENT_PREFIX } from '@brainstrike/file-explorer-hooks';
import {
  DEFAULT_MAX_FILE_SIZE,
  type FileSystemAdapter,
  type HandleCache,
  MockFileSystemAdapter,
  resetFileSizeConfig,
  setFileSizeConfig,
  WebFileSystemAdapter,
} from '@brainstrike/file-system';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import { BINARY_CONTENT_MESSAGE, type IFileNode } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils';
import type {
  FileContentReadResult,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import {
  getCachedFileRequestName,
  useSharedFileContentLoading,
} from '../use-shared-file-content-loading';

// Mock the worker
vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(() => vi.fn()),
}));

// Partially mock the index context hook so the cross-root tests can inject a
// real FileTreeIndex (the default passthrough keeps every other test on the
// real implementation, which returns null outside a FileTreeProvider).
vi.mock('../tree/file-tree-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tree/file-tree-provider')>();
  return {
    ...actual,
    useOptionalFileTreeIndexContext: vi.fn(actual.useOptionalFileTreeIndexContext),
  };
});

function useTestHook(fileTree: IFileNode[]) {
  const store = useFileExplorerStoreContext();
  const loading = useSharedFileContentLoading(fileTree);
  return { store, ...loading };
}

function createWrapper(adapter: FileSystemAdapter) {
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

interface TestHandleCache {
  getFileHandle: (folderId: string, relativePath: string) => Promise<FileSystemFileHandle | null>;
}

function attachHandleCache(adapter: MockFileSystemAdapter, handleCache: TestHandleCache): void {
  (
    adapter as unknown as {
      getHandleCache: () => TestHandleCache;
    }
  ).getHandleCache = () => handleCache;
}

function attachAbsolutePathRead(
  adapter: MockFileSystemAdapter,
  readFileByPath: (absolutePath: string) => Promise<string>
): void {
  (
    adapter as unknown as {
      readFileByAbsolutePath: (
        absolutePath: string,
        rootPath: string,
        rootId: string
      ) => Promise<string>;
    }
  ).readFileByAbsolutePath = (absolutePath) => readFileByPath(absolutePath);
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
          const results: Record<string, FileContentReadResult> = {};
          for (const req of requests) {
            try {
              const content = req.handle ? await adapter.readFile(req.handle) : 'No handle';
              results[req.compositeKey] = { content, status: 'accessible' };
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch {
              results[req.compositeKey] = {
                message: 'Error accessing file',
                status: 'inaccessible',
              };
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
          const results: Record<string, FileContentReadResult> = {};
          for (const req of requests) {
            try {
              const content = req.handle ? await adapter.readFile(req.handle) : 'No handle';
              results[req.compositeKey] = { content, status: 'accessible' };
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch {
              results[req.compositeKey] = {
                message: 'Error accessing file',
                status: 'inaccessible',
              };
            }
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      { initialProps: { tree: [fileNode1] }, wrapper }
    );

    // Allow debounced cache rebuild to complete
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(readSpy.mock.calls[1]?.[0]._internal).toBe(fileNode2.handle);
  });
});

describe('getCachedFileRequestName', () => {
  it('extracts slash-delimited file names without changing trailing slash behavior', () => {
    expect(getCachedFileRequestName('/root/src/cached.txt')).toBe('cached.txt');
    expect(getCachedFileRequestName('cached.txt')).toBe('cached.txt');
    expect(getCachedFileRequestName('/root/src/')).toBe('/root/src/');
    expect(getCachedFileRequestName('')).toBe('');
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
      vi.fn().mockResolvedValue({
        [compositeKey]: { message: 'Error accessing file', status: 'inaccessible' },
      })
    );

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe(
      `${INACCESSIBLE_CONTENT_PREFIX} - Error accessing file`
    );
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
      vi.fn().mockResolvedValue({
        [compositeKey]: {
          message: BINARY_CONTENT_MESSAGE,
          status: 'inaccessible',
        },
      })
    );

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe(BINARY_CONTENT_MESSAGE);
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
        return { content, status: 'accessible' as const };
      } catch {
        if (progressCallback) {
          progressCallback({ key: req.compositeKey });
        }
        return { message: 'Error accessing file', status: 'inaccessible' as const };
      }
    };

    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, FileContentReadResult> = {};

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
      loadingPromise = result.current.handleFileContentLoading([key1, key2], 'background');
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toMatch('File too large');
    expect(mockWorker).not.toHaveBeenCalled();
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
    const mockWorker = vi.fn().mockResolvedValue({
      [compositeKey]: { content: 'loaded', status: 'accessible' },
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
    const mockWorker = vi.fn().mockResolvedValue({
      [compositeKey]: { content: 'loaded', status: 'accessible' },
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
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
      vi.fn().mockResolvedValue({
        [compositeKey]: { content: 'retry', status: 'accessible' },
      })
    );

    vi.useFakeTimers();

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([withoutHandle]), { wrapper });

    await act(async () => {
      const promise = result.current.handleFileContentLoading([compositeKey], 'background');
      vi.advanceTimersByTime(100);
      await promise;
      rerender();
    });

    vi.useRealTimers();

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(result.current.fileContents[compositeKey]).toBe('retry');
  });

  it('reads through a cached browser handle when the indexed file node has no handle', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    const cachedHandle = {
      kind: 'file',
      name: 'cached.txt',
      queryPermission: vi.fn(async () => 'granted' satisfies PermissionState),
    } as unknown as FileSystemFileHandle;
    const handleCache: TestHandleCache = {
      getFileHandle: vi.fn(async () => cachedHandle),
    };
    attachHandleCache(adapter, handleCache);

    const withHandle = createFileNode({ path: '/cached.txt', rootFolderId: 'root1' });
    const withoutHandle = { ...withHandle, handle: undefined as unknown as FileSystemFileHandle };
    const compositeKey = encodeFileSelection('root1', '/cached.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({
      [compositeKey]: { content: 'cached-content', status: 'accessible' },
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([withoutHandle]), { wrapper });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      await vi.advanceTimersByTimeAsync(100);
      await loadPromise;
      rerender();
    });

    expect(handleCache.getFileHandle).toHaveBeenCalledWith('root1', '/cached.txt');
    expect(cachedHandle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          compositeKey,
          handle: expect.objectContaining({
            _internal: cachedHandle,
            name: 'cached.txt',
            path: '/cached.txt',
            platform: 'web',
            rootFolderId: 'root1',
          }),
        }),
      ],
      expect.any(Function)
    );
    expect(result.current.fileContents[compositeKey]).toBe('cached-content');
  });

  it('reports cached browser handles that still need read permission', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    const cachedHandle = {
      kind: 'file',
      name: 'locked.txt',
      queryPermission: vi.fn(async () => 'prompt' satisfies PermissionState),
    } as unknown as FileSystemFileHandle;
    const handleCache: TestHandleCache = {
      getFileHandle: vi.fn(async () => cachedHandle),
    };
    attachHandleCache(adapter, handleCache);

    const withHandle = createFileNode({ path: '/locked.txt', rootFolderId: 'root1' });
    const withoutHandle = { ...withHandle, handle: undefined as unknown as FileSystemFileHandle };
    const compositeKey = encodeFileSelection('root1', '/locked.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([withoutHandle]), { wrapper });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      await vi.advanceTimersByTimeAsync(100);
      await loadPromise;
      rerender();
    });

    expect(handleCache.getFileHandle).toHaveBeenCalledWith('root1', '/locked.txt');
    expect(cachedHandle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(mockWorker).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toMatch('permission required: /locked.txt');
  });

  it('preserves cached permission errors when the file is missing from the indexed tree', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    (adapter as unknown as { readFileByPath?: unknown }).readFileByPath = undefined;
    const cachedHandle = {
      kind: 'file',
      name: 'missing-locked.txt',
      queryPermission: vi.fn(async () => 'prompt' satisfies PermissionState),
    } as unknown as FileSystemFileHandle;
    const handleCache: TestHandleCache = {
      getFileHandle: vi.fn(async () => cachedHandle),
    };
    attachHandleCache(adapter, handleCache);

    const compositeKey = encodeFileSelection('root1', '/missing-locked.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const indexedNode = createFileNode({ path: '/indexed.txt', rootFolderId: 'root1' });
    const { result, rerender } = renderHook(() => useTestHook([indexedNode]), { wrapper });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      await vi.advanceTimersByTimeAsync(100);
      await loadPromise;
      rerender();
    });

    expect(handleCache.getFileHandle).toHaveBeenCalledWith('root1', '/missing-locked.txt');
    expect(cachedHandle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(mockWorker).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toMatch(
      'permission required: /missing-locked.txt'
    );
    expect(result.current.fileContents[compositeKey]).not.toContain('File not found');
  });

  it('uses a cached web handle instead of treating readFileByPath as absolute-path authority', async () => {
    vi.useFakeTimers();
    const rootId = '11111111-0000-4000-8000-000000000011';
    const path = '/cached-web.txt';
    const compositeKey = encodeFileSelection(rootId, path);
    const cachedHandle = {
      kind: 'file',
      name: 'cached-web.txt',
      queryPermission: vi.fn(async () => 'granted' satisfies PermissionState),
    } as unknown as FileSystemFileHandle;
    const getFileHandle = vi.fn(async () => cachedHandle);
    const handleCache = {
      getFileHandle,
      pruneOldHandles: vi.fn(async () => undefined),
    } as unknown as HandleCache;
    const adapter = new WebFileSystemAdapter({ handleCache });
    const readFileByPath = vi.spyOn(adapter, 'readFileByPath');
    const otherNode = createFileNode({ path: '/other.txt', rootFolderId: rootId });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockImplementation(async (requests: FileReadRequest[]) => ({
      [compositeKey]: requests[0]?.handle
        ? { content: 'cached web content', status: 'accessible' as const }
        : { message: 'missing cached handle', status: 'inaccessible' as const },
    }));
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([otherNode]), { wrapper });
    act(() => {
      result.current.store.getState().setActiveRoots([
        {
          displayName: 'Project',
          path: 'Project',
          rootId,
        },
      ]);
    });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      await vi.advanceTimersByTimeAsync(100);
      await loadPromise;
    });

    expect(getFileHandle).toHaveBeenCalledExactlyOnceWith(rootId, path);
    expect(cachedHandle.queryPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'read' });
    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          compositeKey,
          handle: expect.objectContaining({ _internal: cachedHandle, platform: 'web' }),
          path,
        }),
      ],
      expect.any(Function)
    );
    expect(readFileByPath).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBe('cached web content');
  });

  it('rejects directory nodes before queueing worker reads', async () => {
    const adapter = new MockFileSystemAdapter();
    const directoryNode = createFileNode({ path: '/folder', rootFolderId: 'root1' });
    directoryNode.type = 'directory';
    const compositeKey = encodeFileSelection('root1', '/folder');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([directoryNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
      rerender();
    });

    expect(mockWorker).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBe('Not a file: /folder');
  });

  it('limits concurrent loading to MAX_CONCURRENT_LOADS', async () => {
    const adapter = new MockFileSystemAdapter();

    const MaxConcurrentLoads = 20;
    const total = MaxConcurrentLoads + 5;
    const nodes: IFileNode[] = [];
    const keys: string[] = [];
    const results: Record<string, FileContentReadResult> = {};

    for (let i = 0; i < total; i++) {
      const node = createFileNode({ path: `/file${i}.txt`, rootFolderId: 'root1' });
      nodes.push(node);
      const key = encodeFileSelection('root1', node.path);
      keys.push(key);
      results[key] = { content: `content-${i}`, status: 'accessible' };
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
      await result.current.handleFileContentLoading(keys, 'background');
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
      await result.current.handleFileContentLoading([], 'background');
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingFiles.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('leaves an empty-tree read unloaded when mounted-root authority has not arrived yet', async () => {
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue('deferred-content');
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;
    attachAbsolutePathRead(adapter, readFileByPathSpy);

    const compositeKey = encodeFileSelection('root1', '/deferred.txt');
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({
      [compositeKey]: { content: 'deferred-content', status: 'accessible' },
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
    });

    expect(mockWorker).not.toHaveBeenCalled();
    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBeUndefined();
  });

  it('keeps a restored Electron tab retryable while direct root identity is unavailable', async () => {
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue('should-not-be-used');
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;
    attachAbsolutePathRead(adapter, readFileByPathSpy);

    const otherNode = createFileNode({ path: '/other.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/restored.txt');

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockImplementation(async (requests: FileReadRequest[]) => {
      if (requests.length === 0) {
        return {};
      }
      return {
        [compositeKey]: { content: 'restored-content', status: 'accessible' as const },
      };
    });
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([otherNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey], 'background');
    });

    expect(mockWorker).not.toHaveBeenCalled();
    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBeUndefined();
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
    attachAbsolutePathRead(adapter, readFileByPathSpy);

    const rootFolderId = '22222222-0000-4000-8000-000000000022';
    const compositeKey = encodeFileSelection(rootFolderId, 'src/dynamic.ts');
    const otherNode = createFileNode({ path: '/other.txt', rootFolderId });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, FileContentReadResult> = {};
          for (const request of requests) {
            results[request.compositeKey] = {
              content: request.handle
                ? await adapter.readFile(request.handle)
                : await readFileByPathSpy(request.path),
              status: 'accessible',
            };
            progressCallback?.({ key: request.compositeKey });
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([otherNode]), { wrapper });
    act(() => {
      result.current.store.getState().setActiveRoots([
        {
          displayName: 'root',
          path: '/workspace/root',
          rootId: rootFolderId,
        },
      ]);
    });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      vi.advanceTimersByTime(100);
      await loadPromise;
    });

    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          absoluteRootId: rootFolderId,
          absoluteRootPath: '/workspace/root',
          compositeKey,
          path: '/workspace/root/src/dynamic.ts',
        }),
      ],
      expect.any(Function)
    );
    expect(readFileByPathSpy).toHaveBeenCalledWith('/workspace/root/src/dynamic.ts');
    expect(result.current.fileContents[compositeKey]).toBe('agent-selected-content');
    expect(result.current.loadingFiles.size).toBe(0);
  });

  it('resolves direct-path reads through the root descriptor when folderId is a RootId UUID', async () => {
    // Storage v5: composite keys carry a RootId UUID, not the root path.
    // Restored workspace tabs hit this path on reload before the lazy tree
    // contains the file — the hook must resolve the UUID to the descriptor's
    // absolute path or desktop tab restoration deadlocks in deferred retries.
    vi.useFakeTimers();
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileNodeCache') {
        captured.push(record);
      }
    });
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue('restored-tab-content');
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;
    attachAbsolutePathRead(adapter, readFileByPathSpy);

    const rootId = '11111111-0000-4000-8000-000000000011';
    const compositeKey = encodeFileSelection(rootId, '/workspace/root/src/restored.ts');
    const otherNode = createFileNode({ path: '/other.txt', rootFolderId: rootId });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, FileContentReadResult> = {};
          for (const request of requests) {
            results[request.compositeKey] = {
              content: await readFileByPathSpy(request.path),
              status: 'accessible',
            };
            progressCallback?.({ key: request.compositeKey });
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([otherNode]), { wrapper });

    act(() => {
      result.current.store.getState().setActiveRoots([
        {
          displayName: 'root',
          path: '/workspace/root',
          rootId,
        },
      ]);
    });

    try {
      await act(async () => {
        const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
        vi.advanceTimersByTime(100);
        await loadPromise;
      });
    } finally {
      removeListener();
    }

    expect(mockWorker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          absoluteRootId: rootId,
          absoluteRootPath: '/workspace/root',
          compositeKey,
          path: '/workspace/root/src/restored.ts',
        }),
      ],
      expect.any(Function)
    );
    expect(readFileByPathSpy).toHaveBeenCalledWith('/workspace/root/src/restored.ts');
    expect(result.current.fileContents[compositeKey]).toBe('restored-tab-content');
    expect(result.current.loadingFiles.size).toBe(0);
    expect(captured).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.WARN,
          message: 'Node not found in cache or tree',
        }),
      ])
    );
  });

  it('keeps a handleless file unloaded until durable direct-read authority arrives', async () => {
    vi.useFakeTimers();
    const adapter = new MockFileSystemAdapter();
    const readFileByPathSpy = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue('should-not-be-used');
    (
      adapter as unknown as {
        readFileByPath: typeof readFileByPathSpy;
      }
    ).readFileByPath = readFileByPathSpy;
    attachAbsolutePathRead(adapter, readFileByPathSpy);

    const compositeKey = encodeFileSelection('root1', '/missing.txt');
    const fileNode = createFileNode({ path: '/other.txt', rootFolderId: 'root1' });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi.fn().mockResolvedValue({});
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      const loadPromise = result.current.handleFileContentLoading([compositeKey], 'background');
      vi.advanceTimersByTime(100);
      await loadPromise;
    });

    expect(readFileByPathSpy).not.toHaveBeenCalled();
    expect(mockWorker).not.toHaveBeenCalled();
    expect(result.current.fileContents[compositeKey]).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('useSharedFileContentLoading - cross-root import (Phase 6)', () => {
  it('loads a NON-focused root file via the shared FileTreeIndex while the tree holds the focused root', async () => {
    vi.useFakeTimers();
    const ROOT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const ROOT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi
      .spyOn(adapter, 'readFile')
      .mockImplementation(async (handle) => `content of ${handle.path}`);

    const nodeA = createFileNode({ path: '/a.ts', rootFolderId: ROOT_A });
    const nodeB = createFileNode({ path: '/b.ts', rootFolderId: ROOT_B });
    const keyA = encodeFileSelection(ROOT_A, '/a.ts');
    const keyB = encodeFileSelection(ROOT_B, '/b.ts');

    // The shared forest index carries BOTH roots' nodes (Phase 6 sharing);
    // the loader's fileTree prop only ever holds the FOCUSED root's tree.
    const { FileTreeIndex } = await import('../tree/file-tree-index');
    const { useOptionalFileTreeIndexContext } = await import('../tree/file-tree-provider');
    const sharedIndex = new FileTreeIndex();
    sharedIndex.addNodes([nodeA, nodeB], null);
    vi.mocked(useOptionalFileTreeIndexContext).mockReturnValue({
      getHandle: (folderId: string, path: string) => sharedIndex.getHandle(folderId, path),
      getNode: (folderId: string, path: string) => sharedIndex.getNode(folderId, path),
      stats: sharedIndex.stats,
      version: 1,
    });

    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    const mockWorker = vi
      .fn()
      .mockImplementation(
        async (
          requests: FileReadRequest[],
          progressCallback?: (event: { key: string }) => void
        ) => {
          const results: Record<string, FileContentReadResult> = {};
          for (const req of requests) {
            results[req.compositeKey] = {
              content: req.handle ? await adapter.readFile(req.handle) : 'No handle',
              status: 'accessible',
            };
            progressCallback?.({ key: req.compositeKey });
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    try {
      const wrapper = createWrapper(adapter);
      // fileTree = focused root A only; root B resolves ONLY via the index.
      const { result } = renderHook(() => useTestHook([nodeA]), { wrapper });

      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      await act(async () => {
        await result.current.handleFileContentLoading([keyA, keyB], 'background');
      });

      expect(result.current.fileContents[keyA]).toBe('content of /a.ts');
      expect(result.current.fileContents[keyB]).toBe('content of /b.ts');
      expect(readSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.mocked(useOptionalFileTreeIndexContext).mockRestore();
      vi.useRealTimers();
    }
  });
});
