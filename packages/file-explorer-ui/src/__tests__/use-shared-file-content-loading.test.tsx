import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, fileContent, fileExplorer } from '@brainstrike/utils';
import type { FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../file-explorer-provider';
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
              const content = await adapter.readFile(req.handle);
              results[req.compositeKey] = content;
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch (error) {
              results[req.compositeKey] = 'Error accessing file';
            }
          }
          return results;
        }
      );
    vi.mocked(createFileContentWorker).mockReturnValue(mockWorker);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

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
              const content = await adapter.readFile(req.handle);
              results[req.compositeKey] = content;
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch (error) {
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

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    act(() => {
      result.current.store.getState().clearFileContents([compositeKey]);
    });

    rerender({ tree: [fileNode2] });

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
            try {
              const content = await adapter.readFile(req.handle);
              results[req.compositeKey] = content;
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            } catch (error) {
              results[req.compositeKey] = 'Error accessing file';
              if (progressCallback) {
                progressCallback({ key: req.compositeKey });
              }
            }
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

  it('retries when handle is missing on first lookup', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('retry');

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

    const MAX_CONCURRENT_LOADS = 20;
    const total = MAX_CONCURRENT_LOADS + 5;
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
});
