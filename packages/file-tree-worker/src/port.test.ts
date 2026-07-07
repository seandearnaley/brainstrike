import { describe, expect, it, vi } from 'vitest';
import { createFileTreeWorkerPort } from './port';
import type {
  FlattenedNode,
  MainToWorkerMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

type WorkerMessageListener = (event: MessageEvent<WorkerToMainMessage>) => void;
type WorkerErrorListener = (event: ErrorEvent) => void;

class MockWorker {
  public postedMessages: MainToWorkerMessage[] = [];
  public listeners = new Set<WorkerMessageListener>();
  public errorListeners = new Set<WorkerErrorListener>();
  public terminated = false;

  addEventListener(type: string, listener: WorkerMessageListener | WorkerErrorListener): void {
    if (type === 'message') {
      this.listeners.add(listener as WorkerMessageListener);
    }
    if (type === 'error') {
      this.errorListeners.add(listener as WorkerErrorListener);
    }
  }

  removeEventListener(type: string, listener: WorkerMessageListener | WorkerErrorListener): void {
    if (type === 'message') {
      this.listeners.delete(listener as WorkerMessageListener);
    }
    if (type === 'error') {
      this.errorListeners.delete(listener as WorkerErrorListener);
    }
  }

  postMessage(message: MainToWorkerMessage): void {
    this.postedMessages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: WorkerToMainMessage): void {
    const event = { data: message } as MessageEvent<WorkerToMainMessage>;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  emitError(message: string): void {
    const event = { message } as ErrorEvent;
    for (const listener of this.errorListeners) {
      try {
        listener(event);
      } catch {
        // Browser EventTarget dispatch does not rethrow listener exceptions to the caller.
      }
    }
  }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createDirectoryNode = (path: string): WorkerFileNode => ({
  depth: 1,
  loadState: 'unloaded',
  name: path.split('/').at(-1) ?? 'node',
  path,
  rootFolderId: 'root',
  type: 'directory',
});

describe('createFileTreeWorkerPort', () => {
  it('sends command messages and tracks worker readiness', () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const children = [createDirectoryNode('/root/child')];

    expect(port.isReady()).toBe(false);

    port.init(children, 'folder-1');
    port.collapseAll();
    port.updateTree('/root', children);
    port.sendLoadResult('/root', children);
    port.sendLoadError('/root', 'failed');
    port.flattenTree(['/root']);

    expect(worker.postedMessages).toContainEqual({
      payload: { folderId: 'folder-1', rootNodes: children },
      type: 'init',
    });
    expect(worker.postedMessages).toContainEqual({ type: 'collapseAll' });
    expect(worker.postedMessages).toContainEqual({
      payload: { children, loadState: 'loaded', path: '/root' },
      type: 'updateTree',
    });
    expect(worker.postedMessages).toContainEqual({
      payload: { children, path: '/root' },
      type: 'loadResult',
    });
    expect(worker.postedMessages).toContainEqual({
      payload: { error: 'failed', path: '/root' },
      type: 'loadError',
    });
    expect(worker.postedMessages).toContainEqual({
      payload: { expandedPaths: ['/root'] },
      type: 'flattenTree',
    });

    worker.emit({ type: 'ready' });
    expect(port.isReady()).toBe(true);
  });

  it('registers and unregisters event handlers', () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const onProgress = vi.fn();
    const onTreeSnapshot = vi.fn();
    const onChildrenLoaded = vi.fn();
    const onNodeLoadStateChanged = vi.fn();
    const onExpandedPathsDelta = vi.fn();
    const onError = vi.fn();
    const onLog = vi.fn();
    const onFlattenedRows = vi.fn();
    const flattenedNode: FlattenedNode = {
      depth: 1,
      node: createDirectoryNode('/root/a'),
    };

    const offProgress = port.onProgress(onProgress);
    const offTreeSnapshot = port.onTreeSnapshot(onTreeSnapshot);
    const offChildrenLoaded = port.onChildrenLoaded(onChildrenLoaded);
    const offNodeLoadStateChanged = port.onNodeLoadStateChanged(onNodeLoadStateChanged);
    const offExpandedPathsDelta = port.onExpandedPathsDelta(onExpandedPathsDelta);
    const offError = port.onError(onError);
    const offLog = port.onLog(onLog);
    const offFlattened = port.onFlattenedRows(onFlattenedRows);

    worker.emit({
      operationId: 1,
      payload: { currentPath: '/root/a', loaded: 1, total: 3 },
      type: 'progress',
    });
    worker.emit({
      payload: { expandedPaths: ['/root/a'], tree: [createDirectoryNode('/root/a')] },
      type: 'treeSnapshot',
    });
    worker.emit({
      payload: {
        children: [createDirectoryNode('/root/a/child')],
        loadState: 'loaded',
        path: '/root/a',
      },
      type: 'childrenLoaded',
    });
    worker.emit({
      payload: { loadState: 'loading', path: '/root/a' },
      type: 'nodeLoadStateChanged',
    });
    worker.emit({
      payload: { added: ['/root/a'], removed: [] },
      type: 'expandedPathsDelta',
    });
    worker.emit({
      payload: { message: 'path failed', path: '/root/a' },
      type: 'error',
    });
    worker.emit({
      data: { count: 1 },
      level: 'debug',
      message: 'worker log',
      type: 'log',
    });
    worker.emit({
      payload: { count: 1, durationMs: 8, nodes: [flattenedNode] },
      type: 'flattenedRows',
    });

    expect(onProgress).toHaveBeenCalledWith(1, 3, '/root/a');
    expect(onTreeSnapshot).toHaveBeenCalledWith([createDirectoryNode('/root/a')], ['/root/a']);
    expect(onChildrenLoaded).toHaveBeenCalledWith('/root/a', [
      createDirectoryNode('/root/a/child'),
    ]);
    expect(onNodeLoadStateChanged).toHaveBeenCalledWith('/root/a', 'loading', undefined);
    expect(onExpandedPathsDelta).toHaveBeenCalledWith(['/root/a'], []);
    expect(onError).toHaveBeenCalledWith('path failed', '/root/a');
    expect(onLog).toHaveBeenCalledWith('debug', 'worker log', { count: 1 });
    expect(onFlattenedRows).toHaveBeenCalledWith([flattenedNode], 1, 8);

    offProgress();
    offTreeSnapshot();
    offChildrenLoaded();
    offNodeLoadStateChanged();
    offExpandedPathsDelta();
    offError();
    offLog();
    offFlattened();

    worker.emit({
      operationId: 1,
      payload: { currentPath: '/root/b', loaded: 2, total: 3 },
      type: 'progress',
    });
    worker.emit({
      payload: { expandedPaths: ['/root/b'], tree: [createDirectoryNode('/root/b')] },
      type: 'treeSnapshot',
    });
    worker.emit({
      payload: { children: [], loadState: 'loaded', path: '/root/b' },
      type: 'childrenLoaded',
    });
    worker.emit({
      payload: { loadState: 'loaded', path: '/root/b' },
      type: 'nodeLoadStateChanged',
    });
    worker.emit({
      payload: { added: [], removed: ['/root/a'] },
      type: 'expandedPathsDelta',
    });
    worker.emit({
      payload: { message: 'ignored', path: '/root/b' },
      type: 'error',
    });
    worker.emit({
      data: { count: 2 },
      level: 'info',
      message: 'ignored',
      type: 'log',
    });
    worker.emit({
      payload: { count: 0, durationMs: 1, nodes: [] },
      type: 'flattenedRows',
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(onChildrenLoaded).toHaveBeenCalledTimes(1);
    expect(onNodeLoadStateChanged).toHaveBeenCalledTimes(1);
    expect(onExpandedPathsDelta).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onFlattenedRows).toHaveBeenCalledTimes(1);
  });

  it('handles requestLoad responses and errors', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const child = createDirectoryNode('/root/a/child');

    const offRequestLoad = port.onRequestLoad(async (requestId, paths) => {
      expect(requestId).toBe('req-1');
      expect(paths).toEqual(['/root/a', '/root/b']);
      return [
        { children: [child], path: '/root/a' },
        { error: 'permission denied', path: '/root/b' },
      ];
    });

    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/a', '/root/b'], requestId: 'req-1' },
      type: 'requestLoad',
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      payload: { children: [child], path: '/root/a', requestId: 'req-1' },
      type: 'loadResult',
    });
    expect(worker.postedMessages).toContainEqual({
      payload: { error: 'permission denied', path: '/root/b', requestId: 'req-1' },
      type: 'loadError',
    });

    offRequestLoad();
    worker.postedMessages = [];

    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/c'], requestId: 'req-2' },
      type: 'requestLoad',
    });
    await flushMicrotasks();
    expect(worker.postedMessages).toEqual([]);

    port.onRequestLoad(async () => {
      throw new Error('handler crashed');
    });
    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/d', '/root/e'], requestId: 'req-3' },
      type: 'requestLoad',
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      payload: { error: 'handler crashed', path: '/root/d', requestId: 'req-3' },
      type: 'loadError',
    });
    expect(worker.postedMessages).toContainEqual({
      payload: { error: 'handler crashed', path: '/root/e', requestId: 'req-3' },
      type: 'loadError',
    });
  });

  it('resolves and rejects long-running operations correctly', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);

    const expandAllPromise = port.expandAll('folder-1');
    expect(worker.postedMessages.at(-1)).toEqual({
      operationId: 1,
      payload: { folderId: 'folder-1' },
      type: 'expandAll',
    });

    worker.emit({
      operationId: 1,
      payload: { expandedPaths: ['/root/a'], loadedCount: 1 },
      type: 'complete',
    });
    await expect(expandAllPromise).resolves.toEqual({
      expandedPaths: ['/root/a'],
      loadedCount: 1,
      patches: [],
    });

    const loadPathsPromise = port.loadPaths(['/root/a']);
    const loadSubtreePromise = port.loadSubtree('/root/b');
    await expect(loadPathsPromise).rejects.toThrow('Operation aborted by new request');
    expect(worker.postedMessages).toContainEqual({
      operationId: 2,
      payload: { paths: ['/root/a'] },
      type: 'loadPaths',
    });
    expect(worker.postedMessages).toContainEqual({ type: 'abort' });
    expect(worker.postedMessages).toContainEqual({
      operationId: 3,
      payload: { startPath: '/root/b' },
      type: 'loadSubtree',
    });

    worker.emit({
      operationId: 3,
      payload: { expandedPaths: ['/root/b'], loadedCount: 2 },
      type: 'complete',
    });
    await expect(loadSubtreePromise).resolves.toEqual({
      expandedPaths: ['/root/b'],
      loadedCount: 2,
      patches: [],
    });

    const abortPromise = port.expandAll('folder-2');
    port.abort();
    await expect(abortPromise).rejects.toThrow('Operation aborted');
    expect(worker.postedMessages.at(-1)).toEqual({ type: 'abort' });
  });

  it('does not attach stale patches from a superseded operation to the active result', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const staleChild = createDirectoryNode('/root/stale-child');
    const activeChild = createDirectoryNode('/root/active-child');

    const stalePromise = port.loadPaths(['/root/stale']);
    const activePromise = port.loadPaths(['/root/active']);

    await expect(stalePromise).rejects.toThrow('Operation aborted by new request');

    worker.emit({
      operationId: 1,
      payload: { children: [staleChild], loadState: 'loaded', path: '/root/stale' },
      type: 'childrenLoaded',
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      payload: { children: [activeChild], loadState: 'loaded', path: '/root/active' },
      type: 'childrenLoaded',
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      payload: { added: ['/root/active'], removed: [] },
      type: 'expandedPathsDelta',
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      payload: { expandedPaths: ['/root/active'], loadedCount: 1 },
      type: 'complete',
    } as WorkerToMainMessage);

    await expect(activePromise).resolves.toEqual({
      expandedPaths: ['/root/active'],
      loadedCount: 1,
      patches: [
        {
          operationId: 2,
          payload: { children: [activeChild], loadState: 'loaded', path: '/root/active' },
          type: 'childrenLoaded',
        },
      ],
    });
  });

  it('delivers standalone update patches without adding them to an active operation result', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const standaloneChild = createDirectoryNode('/root/standalone-child');
    const activeChild = createDirectoryNode('/root/active-child');
    const onChildrenLoaded = vi.fn();
    const onExpandedPathsDelta = vi.fn();

    port.onChildrenLoaded(onChildrenLoaded);
    port.onExpandedPathsDelta(onExpandedPathsDelta);
    const activePromise = port.loadPaths(['/root/active']);

    worker.emit({
      payload: { children: [standaloneChild], loadState: 'loaded', path: '/root/standalone' },
      type: 'childrenLoaded',
    } as WorkerToMainMessage);
    worker.emit({
      payload: { added: ['/root/standalone'], removed: [] },
      type: 'expandedPathsDelta',
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 1,
      payload: { children: [activeChild], loadState: 'loaded', path: '/root/active' },
      type: 'childrenLoaded',
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 1,
      payload: { expandedPaths: ['/root/active'], loadedCount: 1 },
      type: 'complete',
    } as WorkerToMainMessage);

    expect(onChildrenLoaded).toHaveBeenCalledWith('/root/standalone', [standaloneChild]);
    expect(onExpandedPathsDelta).toHaveBeenCalledWith(['/root/standalone'], []);
    await expect(activePromise).resolves.toEqual({
      expandedPaths: ['/root/active'],
      loadedCount: 1,
      patches: [
        {
          operationId: 1,
          payload: { children: [activeChild], loadState: 'loaded', path: '/root/active' },
          type: 'childrenLoaded',
        },
      ],
    });
  });

  it('propagates worker errors to active operations and listeners', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const onError = vi.fn();
    port.onError(onError);

    const pending = port.expandAll('folder-1');
    worker.emit({
      operationId: 1,
      payload: { message: 'load failed', path: '/root/a' },
      type: 'error',
    });

    await expect(pending).rejects.toThrow('load failed');
    expect(onError).toHaveBeenCalledWith('load failed', '/root/a');

    worker.emit({
      payload: { message: 'standalone error', path: '/root/b' },
      type: 'error',
    });
    expect(onError).toHaveBeenCalledWith('standalone error', '/root/b');
  });

  it('rejects the active operation on id-less global worker errors', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);

    const pending = port.expandAll('folder-1');
    worker.emit({
      payload: { message: 'global worker failure' },
      type: 'error',
    });

    await expect(pending).rejects.toThrow('global worker failure');
  });

  it('removes listeners and terminates the worker', () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const onProgress = vi.fn();
    port.onProgress(onProgress);

    port.terminate();
    expect(worker.terminated).toBe(true);

    worker.emit({
      operationId: 1,
      payload: { currentPath: '/root/a', loaded: 1, total: 1 },
      type: 'progress',
    });
    expect(onProgress).not.toHaveBeenCalled();
  });
});
