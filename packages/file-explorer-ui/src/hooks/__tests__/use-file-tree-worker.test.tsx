import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { BatchLoadResult } from '@brainstrike/file-tree-worker';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTreeWorker } from '../use-file-tree-worker';

const workerState = vi.hoisted(() => ({
  errorHandler: null as ((message: string, path?: string) => void) | null,
  instances: [] as Array<{
    onerror?: (event: ErrorEvent) => void;
    terminate: ReturnType<typeof vi.fn>;
  }>,
  logHandler: null as ((level: string, message: string, data?: unknown) => void) | null,
  onErrorUnsubscribe: vi.fn(),
  onLogUnsubscribe: vi.fn(),
  onProgressUnsubscribe: vi.fn(),
  onRequestLoadUnsubscribe: vi.fn(),
  onTreeSnapshotUnsubscribe: vi.fn(),
  portTerminate: vi.fn(),
  progressHandler: null as ((loaded: number, total: number, currentPath: string) => void) | null,
  requestLoadHandler: null as
    | ((requestId: string, paths: string[]) => Promise<BatchLoadResult[]>)
    | null,
}));

vi.mock('@brainstrike/file-tree-worker', () => ({
  createFileTreeWorkerPort: vi.fn(
    (worker: { onerror?: (event: ErrorEvent) => void; terminate: ReturnType<typeof vi.fn> }) => {
      workerState.instances.push(worker);
      return {
        onError: vi.fn((handler: (message: string, path?: string) => void) => {
          workerState.errorHandler = handler;
          return workerState.onErrorUnsubscribe;
        }),
        onLog: vi.fn((handler: (level: string, message: string, data?: unknown) => void) => {
          workerState.logHandler = handler;
          return workerState.onLogUnsubscribe;
        }),
        onProgress: vi.fn(
          (handler: (loaded: number, total: number, currentPath: string) => void) => {
            workerState.progressHandler = handler;
            return workerState.onProgressUnsubscribe;
          }
        ),
        onRequestLoad: vi.fn(
          (handler: (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>) => {
            workerState.requestLoadHandler = handler;
            return workerState.onRequestLoadUnsubscribe;
          }
        ),
        onTreeSnapshot: vi.fn(() => workerState.onTreeSnapshotUnsubscribe),
        terminate: workerState.portTerminate,
      };
    }
  ),
  resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,', import.meta.url)),
}));

vi.stubGlobal(
  'Worker',
  vi.fn().mockImplementation(function MockWorker(this: {
    onerror?: (event: ErrorEvent) => void;
    terminate: ReturnType<typeof vi.fn>;
  }) {
    this.terminate = vi.fn();
  })
);

function getRequestLoadHandler(): (
  requestId: string,
  paths: string[]
) => Promise<BatchLoadResult[]> {
  if (!workerState.requestLoadHandler) {
    throw new Error('expected worker request-load handler');
  }
  return workerState.requestLoadHandler;
}

function createAdapter(
  readDirectory: FileSystemAdapter['readDirectory'] = vi.fn(async () => [])
): FileSystemAdapter {
  return {
    exists: vi.fn(),
    readDirectory,
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    watchDirectory: vi.fn(),
  };
}

function createRootHandle(overrides: Partial<DirectoryHandle> = {}): DirectoryHandle {
  return {
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform: 'web',
    ...overrides,
  };
}

function createFileNode(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    depth: 0,
    handle: {} as unknown as FileSystemFileHandle,
    isVisible: true,
    name: 'child.txt',
    path: '/root/dir/child.txt',
    rootFolderId: '/root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

describe('useFileTreeWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerState.errorHandler = null;
    workerState.instances = [];
    workerState.logHandler = null;
    workerState.progressHandler = null;
    workerState.requestLoadHandler = null;
  });

  it('returns request errors when no file-system adapter is available', async () => {
    renderHook(() => useFileTreeWorker({ fileSystemAdapter: null }));

    const results = await getRequestLoadHandler()('req-1', ['/root/dir']);

    expect(results).toEqual([{ path: '/root/dir', error: 'No file system adapter' }]);
  });

  it('returns request errors when the root handle has no canonical path', async () => {
    const adapter = createAdapter();
    const { result } = renderHook(() => useFileTreeWorker({ fileSystemAdapter: adapter }));

    act(() => {
      result.current.setRootHandle(createRootHandle({ path: '' }));
    });

    const results = await getRequestLoadHandler()('req-2', ['/root/dir']);

    expect(results).toEqual([
      {
        path: '/root/dir',
        error: 'Root directory handle is missing its canonical path',
      },
    ]);
  });

  it('loads worker-requested directories and reports per-path errors', async () => {
    const adapter = createAdapter(
      vi.fn(async (handle) => {
        if (handle.path === '/root/error') {
          throw new Error('disk unavailable');
        }
        return [createFileNode({ name: 'child.txt', path: `${handle.path}/child.txt` })];
      })
    );
    const { result } = renderHook(() => useFileTreeWorker({ fileSystemAdapter: adapter }));

    act(() => {
      result.current.setRootHandle(createRootHandle());
      result.current.handleMapRef.current.set('/root/ok', {
        kind: 'directory',
        name: 'ok',
        path: '/root/ok',
      } as unknown as FileSystemDirectoryHandle);
      result.current.handleMapRef.current.set('/root/error', {
        kind: 'directory',
        name: 'error',
        path: '/root/error',
      } as unknown as FileSystemDirectoryHandle);
    });

    const results = await getRequestLoadHandler()('req-3', [
      '/root/missing',
      '/root/ok',
      '/root/error',
    ]);

    expect(results).toEqual([
      { path: '/root/missing', error: 'Handle not found' },
      {
        path: '/root/ok',
        children: [
          expect.objectContaining({
            name: 'child.txt',
            path: '/root/ok/child.txt',
            type: 'file',
          }),
        ],
      },
      { path: '/root/error', error: 'disk unavailable' },
    ]);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(2);
  });

  it('maps abort exceptions from worker-requested directory loads', async () => {
    const adapter = createAdapter(
      vi.fn(async () => {
        throw new DOMException('Operation was cancelled', 'AbortError');
      })
    );
    const { result } = renderHook(() => useFileTreeWorker({ fileSystemAdapter: adapter }));

    act(() => {
      result.current.setRootHandle(createRootHandle());
      result.current.handleMapRef.current.set('/root/dir', {
        kind: 'directory',
        name: 'dir',
        path: '/root/dir',
      } as unknown as FileSystemDirectoryHandle);
    });

    const results = await getRequestLoadHandler()('req-4', ['/root/dir']);

    expect(results).toEqual([{ path: '/root/dir', error: 'Operation aborted' }]);
  });

  it('forwards worker callbacks through current hook callbacks and cleans up listeners', () => {
    const onError = vi.fn();
    const onProgress = vi.fn();
    const { unmount } = renderHook(() =>
      useFileTreeWorker({
        fileSystemAdapter: createAdapter(),
        onError,
        onProgress,
      })
    );

    act(() => {
      workerState.progressHandler?.(2, 5, '/root/dir');
      workerState.errorHandler?.('Worker exploded', '/root/dir');
      workerState.logHandler?.('error', 'error message', { path: '/root/dir' });
      workerState.logHandler?.('warn', 'warn message');
      workerState.logHandler?.('info', 'info message');
      workerState.logHandler?.('debug', 'debug message');
      workerState.instances[0]?.onerror?.({
        colno: 4,
        filename: 'worker.js',
        lineno: 3,
        message: 'async failure',
      } as ErrorEvent);
    });

    expect(onProgress).toHaveBeenCalledWith(2, 5, '/root/dir');
    expect(onError).toHaveBeenCalledWith(new Error('Worker exploded'));
    expect(onError).toHaveBeenCalledWith(new Error('Worker error: async failure'));

    unmount();

    expect(workerState.onRequestLoadUnsubscribe).toHaveBeenCalledOnce();
    expect(workerState.onTreeSnapshotUnsubscribe).toHaveBeenCalledOnce();
    expect(workerState.onProgressUnsubscribe).toHaveBeenCalledOnce();
    expect(workerState.onErrorUnsubscribe).toHaveBeenCalledOnce();
    expect(workerState.onLogUnsubscribe).toHaveBeenCalledOnce();
    expect(workerState.portTerminate).toHaveBeenCalledOnce();
  });
});
