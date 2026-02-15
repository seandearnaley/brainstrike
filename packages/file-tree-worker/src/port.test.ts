import { describe, expect, it, vi } from 'vitest';
import { createFileTreeWorkerPort } from './port';
import type {
  FlattenedNode,
  MainToWorkerMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

type WorkerMessageListener = (event: MessageEvent<WorkerToMainMessage>) => void;

class MockWorker {
  public postedMessages: MainToWorkerMessage[] = [];
  public listeners = new Set<WorkerMessageListener>();
  public terminated = false;

  addEventListener(type: string, listener: WorkerMessageListener): void {
    if (type === 'message') {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: WorkerMessageListener): void {
    if (type === 'message') {
      this.listeners.delete(listener);
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
    const onError = vi.fn();
    const onLog = vi.fn();
    const onFlattenedResult = vi.fn();
    const flattenedNode: FlattenedNode = {
      node: createDirectoryNode('/root/a'),
      depth: 1,
    };

    const offProgress = port.onProgress(onProgress);
    const offTreeSnapshot = port.onTreeSnapshot(onTreeSnapshot);
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
      type: 'flattenedResult',
      payload: { nodes: [flattenedNode], count: 1, durationMs: 8 },
    });

    expect(onProgress).toHaveBeenCalledWith(1, 3, '/root/a');
    expect(onTreeSnapshot).toHaveBeenCalledWith([createDirectoryNode('/root/a')], ['/root/a']);
    expect(onError).toHaveBeenCalledWith('path failed', '/root/a');
    expect(onLog).toHaveBeenCalledWith('debug', 'worker log', { count: 1 });
    expect(onFlattenedResult).toHaveBeenCalledWith([flattenedNode], 1, 8);

    offProgress();
    offTreeSnapshot();
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
      type: 'flattenedResult',
      payload: { nodes: [], count: 0, durationMs: 1 },
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onTreeSnapshot).toHaveBeenCalledTimes(1);
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
      payload: { requestId: 'req-1', paths: ['/root/a', '/root/b'] },
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      type: 'loadResult',
      payload: { path: '/root/a', children: [child] },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { path: '/root/b', error: 'permission denied' },
    });

    offRequestLoad();
    worker.postedMessages = [];

    worker.emit({
      type: 'requestLoad',
      payload: { requestId: 'req-2', paths: ['/root/c'] },
    });
    await flushMicrotasks();
    expect(worker.postedMessages).toEqual([]);

    port.onRequestLoad(async () => {
      throw new Error('handler crashed');
    });
    worker.emit({
      type: 'requestLoad',
      payload: { requestId: 'req-3', paths: ['/root/d', '/root/e'] },
    });
    await flushMicrotasks();

    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { path: '/root/d', error: 'handler crashed' },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadError',
      payload: { path: '/root/e', error: 'handler crashed' },
    });
  });

  it('resolves and rejects long-running operations correctly', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const tree = [createDirectoryNode('/root/a')];

    const expandAllPromise = port.expandAll('folder-1');
    expect(worker.postedMessages.at(-1)).toEqual({
      type: 'expandAll',
      payload: { folderId: 'folder-1' },
    });

    worker.emit({
      type: 'complete',
      payload: { tree, expandedPaths: ['/root/a'], loadedCount: 1 },
    });
    await expect(expandAllPromise).resolves.toEqual({
      tree,
      expandedPaths: ['/root/a'],
      loadedCount: 1,
    });

    const loadPathsPromise = port.loadPaths(['/root/a']);
    const loadSubtreePromise = port.loadSubtree('/root/b');
    await expect(loadPathsPromise).rejects.toThrow('Operation aborted by new request');
    expect(worker.postedMessages).toContainEqual({
      type: 'loadPaths',
      payload: { paths: ['/root/a'] },
    });
    expect(worker.postedMessages).toContainEqual({
      type: 'loadSubtree',
      payload: { startPath: '/root/b' },
    });

    worker.emit({
      type: 'complete',
      payload: { tree, expandedPaths: ['/root/b'], loadedCount: 2 },
    });
    await expect(loadSubtreePromise).resolves.toEqual({
      tree,
      expandedPaths: ['/root/b'],
      loadedCount: 2,
    });

    const abortPromise = port.expandAll('folder-2');
    port.abort();
    await expect(abortPromise).rejects.toThrow('Operation aborted');
    expect(worker.postedMessages.at(-1)).toEqual({ type: 'abort' });
  });

  it('propagates worker errors to active operations and listeners', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const onError = vi.fn();
    port.onError(onError);

    const pending = port.expandAll('folder-1');
    worker.emit({
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
