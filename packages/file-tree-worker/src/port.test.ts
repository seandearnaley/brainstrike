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
  name: path.split('/').at(-1) ?? 'node',
  path,
  type: 'directory',
  depth: 1,
  rootFolderId: 'root',
  loadState: 'unloaded',
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
      type: 'init',
      payload: { rootNodes: children, folderId: 'folder-1' },
    });
    expect(worker.postedMessages).toContainEqual({ type: 'collapseAll' });
    expect(worker.postedMessages).toContainEqual({
      type: 'updateTree',
      payload: { path: '/root', children, loadState: 'loaded' },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadResult',
      payload: { path: '/root', children },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { path: '/root', error: 'failed' },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'flattenTree',
      payload: { expandedPaths: ['/root'] },
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
    const onFlattenedResult = vi.fn();
    const flattenedNode: FlattenedNode = {
      node: createDirectoryNode('/root/a'),
      depth: 1,
    };

    const offProgress = port.onProgress(onProgress);
    const offTreeSnapshot = port.onTreeSnapshot(onTreeSnapshot);
    const offChildrenLoaded = port.onChildrenLoaded(onChildrenLoaded);
    const offNodeLoadStateChanged = port.onNodeLoadStateChanged(onNodeLoadStateChanged);
    const offExpandedPathsDelta = port.onExpandedPathsDelta(onExpandedPathsDelta);
    const offError = port.onError(onError);
    const offLog = port.onLog(onLog);
    const offFlattened = port.onFlattenedResult(onFlattenedResult);

    worker.emit({
      type: 'progress',
      payload: { loaded: 1, total: 3, currentPath: '/root/a' },
    });
    worker.emit({
      type: 'treeSnapshot',
      payload: { tree: [createDirectoryNode('/root/a')], expandedPaths: ['/root/a'] },
    });
    worker.emit({
      type: 'childrenLoaded',
      payload: {
        path: '/root/a',
        children: [createDirectoryNode('/root/a/child')],
        loadState: 'loaded',
      },
    });
    worker.emit({
      type: 'nodeLoadStateChanged',
      payload: { path: '/root/a', loadState: 'loading' },
    });
    worker.emit({
      type: 'expandedPathsDelta',
      payload: { added: ['/root/a'], removed: [] },
    });
    worker.emit({
      type: 'error',
      payload: { message: 'path failed', path: '/root/a' },
    });
    worker.emit({
      type: 'log',
      level: 'debug',
      message: 'worker log',
      data: { count: 1 },
    });
    worker.emit({
      type: 'flattenedRows',
      payload: { nodes: [flattenedNode], count: 1, durationMs: 8 },
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
    expect(onFlattenedResult).toHaveBeenCalledWith([flattenedNode], 1, 8);

    offProgress();
    offTreeSnapshot();
    offChildrenLoaded();
    offNodeLoadStateChanged();
    offExpandedPathsDelta();
    offError();
    offLog();
    offFlattened();

    worker.emit({
      type: 'progress',
      payload: { loaded: 2, total: 3, currentPath: '/root/b' },
    });
    worker.emit({
      type: 'treeSnapshot',
      payload: { tree: [createDirectoryNode('/root/b')], expandedPaths: ['/root/b'] },
    });
    worker.emit({
      type: 'childrenLoaded',
      payload: { path: '/root/b', children: [], loadState: 'loaded' },
    });
    worker.emit({
      type: 'nodeLoadStateChanged',
      payload: { path: '/root/b', loadState: 'loaded' },
    });
    worker.emit({
      type: 'expandedPathsDelta',
      payload: { added: [], removed: ['/root/a'] },
    });
    worker.emit({
      type: 'error',
      payload: { message: 'ignored', path: '/root/b' },
    });
    worker.emit({
      type: 'log',
      level: 'info',
      message: 'ignored',
      data: { count: 2 },
    });
    worker.emit({
      type: 'flattenedRows',
      payload: { nodes: [], count: 0, durationMs: 1 },
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(onChildrenLoaded).toHaveBeenCalledTimes(1);
    expect(onNodeLoadStateChanged).toHaveBeenCalledTimes(1);
    expect(onExpandedPathsDelta).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onFlattenedResult).toHaveBeenCalledTimes(1);
  });

  it('handles requestLoad responses and errors', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const child = createDirectoryNode('/root/a/child');

    const offRequestLoad = port.onRequestLoad(async (requestId, paths) => {
      expect(requestId).toBe('req-1');
      expect(paths).toEqual(['/root/a', '/root/b']);
      return [
        { path: '/root/a', children: [child] },
        { path: '/root/b', error: 'permission denied' },
      ];
    });

    worker.emit({
      type: 'requestLoad',
      operationId: 1,
      payload: { requestId: 'req-1', paths: ['/root/a', '/root/b'] },
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      type: 'loadResult',
      payload: { requestId: 'req-1', path: '/root/a', children: [child] },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { requestId: 'req-1', path: '/root/b', error: 'permission denied' },
    });

    offRequestLoad();
    worker.postedMessages = [];

    worker.emit({
      type: 'requestLoad',
      operationId: 1,
      payload: { requestId: 'req-2', paths: ['/root/c'] },
    });
    await flushMicrotasks();
    expect(worker.postedMessages).toEqual([]);

    port.onRequestLoad(async () => {
      throw new Error('handler crashed');
    });
    worker.emit({
      type: 'requestLoad',
      operationId: 1,
      payload: { requestId: 'req-3', paths: ['/root/d', '/root/e'] },
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { requestId: 'req-3', path: '/root/d', error: 'handler crashed' },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { requestId: 'req-3', path: '/root/e', error: 'handler crashed' },
    });
  });

  it('resolves and rejects long-running operations correctly', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);

    const expandAllPromise = port.expandAll('folder-1');
    expect(worker.postedMessages.at(-1)).toEqual({
      type: 'expandAll',
      operationId: 1,
      payload: { folderId: 'folder-1' },
    });

    worker.emit({
      operationId: 1,
      type: 'complete',
      payload: { expandedPaths: ['/root/a'], loadedCount: 1 },
    });
    await expect(expandAllPromise).resolves.toEqual({
      patches: [],
      expandedPaths: ['/root/a'],
      loadedCount: 1,
    });

    const loadPathsPromise = port.loadPaths(['/root/a']);
    const loadSubtreePromise = port.loadSubtree('/root/b');
    await expect(loadPathsPromise).rejects.toThrow('Operation aborted by new request');
    expect(worker.postedMessages).toContainEqual({
      type: 'loadPaths',
      operationId: 2,
      payload: { paths: ['/root/a'] },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadSubtree',
      operationId: 3,
      payload: { startPath: '/root/b' },
    });

    worker.emit({
      operationId: 3,
      type: 'complete',
      payload: { expandedPaths: ['/root/b'], loadedCount: 2 },
    });
    await expect(loadSubtreePromise).resolves.toEqual({
      patches: [],
      expandedPaths: ['/root/b'],
      loadedCount: 2,
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
      type: 'childrenLoaded',
      payload: { path: '/root/stale', children: [staleChild], loadState: 'loaded' },
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      type: 'childrenLoaded',
      payload: { path: '/root/active', children: [activeChild], loadState: 'loaded' },
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      type: 'expandedPathsDelta',
      payload: { added: ['/root/active'], removed: [] },
    } as WorkerToMainMessage);
    worker.emit({
      operationId: 2,
      type: 'complete',
      payload: { expandedPaths: ['/root/active'], loadedCount: 1 },
    } as WorkerToMainMessage);

    await expect(activePromise).resolves.toEqual({
      patches: [
        {
          operationId: 2,
          type: 'childrenLoaded',
          payload: { path: '/root/active', children: [activeChild], loadState: 'loaded' },
        },
      ],
      expandedPaths: ['/root/active'],
      loadedCount: 1,
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
      type: 'error',
      payload: { message: 'load failed', path: '/root/a' },
    });

    await expect(pending).rejects.toThrow('load failed');
    expect(onError).toHaveBeenCalledWith('load failed', '/root/a');

    worker.emit({
      type: 'error',
      payload: { message: 'standalone error', path: '/root/b' },
    });
    expect(onError).toHaveBeenCalledWith('standalone error', '/root/b');
  });

  it('rejects the active operation on id-less global worker errors', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);

    const pending = port.expandAll('folder-1');
    worker.emit({
      type: 'error',
      payload: { message: 'global worker failure' },
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
      type: 'progress',
      payload: { loaded: 1, total: 1, currentPath: '/root/a' },
    });
    expect(onProgress).not.toHaveBeenCalled();
  });
});
