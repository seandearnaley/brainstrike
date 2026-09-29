import { describe, expect, it, vi } from 'vitest';
import { createFileTreeWorkerPort } from './port';
import type {
  BatchLoadResult,
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const createDirectoryNode = (path: string): WorkerFileNode => ({
  depth: 1,
  loadState: 'unloaded',
  name: path.split('/').at(-1) ?? 'node',
  path,
  rootFolderId: 'root',
  type: 'directory',
});

describe('createFileTreeWorkerPort', () => {
  it.each(['expandAll', 'loadPaths', 'loadSubtree'] as const)(
    'releases %s ownership after synchronous command send failure',
    async (method) => {
      const worker = new MockWorker();
      const port = createFileTreeWorkerPort(worker as unknown as Worker);
      const failure = { message: 'send failed' };
      const post = vi.spyOn(worker, 'postMessage');
      post.mockImplementationOnce(() => {
        throw failure;
      });
      const failed = method === 'loadPaths' ? port.loadPaths(['/root']) : port[method]('/root');
      await expect(failed).rejects.toBe(failure);
      const next = port.loadPaths(['/next']);
      expect(worker.postedMessages.map((message) => message.type)).toEqual(['loadPaths']);
      worker.emit({
        operationId: 2,
        payload: { expandedPaths: [], loadedCount: 0 },
        type: 'complete',
      });
      await expect(next).resolves.toMatchObject({ loadedCount: 0 });
      port.terminate();
    }
  );

  it('releases replacement ownership when supersession abort posting throws', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const first = port.loadPaths(['/first']);
    const firstRejected = expect(first).rejects.toThrow('Operation aborted by new request');
    const failure = new Error('abort posting failed');
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => {
      throw failure;
    });
    await expect(port.loadSubtree('/second')).rejects.toBe(failure);
    await firstRejected;
    const third = port.expandAll('folder');
    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'loadPaths',
      'expandAll',
    ]);
    worker.emit({
      operationId: 3,
      payload: { expandedPaths: [], loadedCount: 0 },
      type: 'complete',
    });
    await expect(third).resolves.toMatchObject({ loadedCount: 0 });
    port.terminate();
  });

  it('keeps synchronous completion when command posting then throws', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const expandedPaths = ['/root'];
    vi.spyOn(worker, 'postMessage').mockImplementationOnce((message) => {
      if (message.type !== 'loadPaths') {
        throw new Error('Expected loadPaths command');
      }
      worker.emit({
        operationId: message.operationId,
        payload: { expandedPaths, loadedCount: 1 },
        type: 'complete',
      });
      throw new Error('after completion');
    });
    const completed = port.loadPaths(['/root']);
    // Posting and correlation are installed before the Promise API returns.
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const result = await completed;
    expect(result.expandedPaths).toBe(expandedPaths);
    expect(result.loadedCount).toBe(1);
    const next = port.loadSubtree('/next');
    expect(worker.postedMessages.map((message) => message.type)).toEqual(['loadSubtree']);
    worker.emit({
      operationId: 2,
      payload: { expandedPaths: [], loadedCount: 0 },
      type: 'complete',
    });
    await expect(next).resolves.toMatchObject({ loadedCount: 0 });
    port.terminate();
  });

  it('old scope cleanup cannot detach a synchronously started replacement', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const first = port.loadPaths(['/first']);
    worker.emit({
      operationId: 1,
      payload: { expandedPaths: [], loadedCount: 1 },
      type: 'complete',
    });
    const replacement = port.loadSubtree('/replacement');
    await first;
    worker.emit({
      operationId: 1,
      payload: { expandedPaths: ['/stale'], loadedCount: 99 },
      type: 'complete',
    });
    worker.emit({
      operationId: 2,
      payload: { expandedPaths: ['/replacement'], loadedCount: 2 },
      type: 'complete',
    });
    await expect(replacement).resolves.toMatchObject({
      expandedPaths: ['/replacement'],
      loadedCount: 2,
    });
    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'loadPaths',
      'loadSubtree',
    ]);
    port.terminate();
  });

  it('stops supersession posting when an aborted load starts a replacement', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const held = createDeferred<BatchLoadResult[]>();
    let replacement: ReturnType<typeof port.loadPaths> | undefined;
    let replacementSignal: AbortSignal | undefined;
    port.onRequestLoad((id, _paths, signal) => {
      if (id === 'replacement-load') {
        replacementSignal = signal;
        return held.promise;
      }
      signal.addEventListener(
        'abort',
        () => {
          replacement = port.loadPaths(['/replacement']);
          worker.emit({
            operationId: 3,
            payload: { paths: ['/replacement'], requestId: 'replacement-load' },
            type: 'requestLoad',
          });
        },
        { once: true }
      );
      return held.promise;
    });
    const first = port.loadPaths(['/first']);
    const firstRejected = expect(first).rejects.toThrow('Operation aborted by new request');
    worker.emit({
      operationId: 1,
      payload: { paths: ['/first'], requestId: 'held' },
      type: 'requestLoad',
    });
    const second = port.loadSubtree('/second');
    await expect(second).rejects.toThrow('Operation aborted by new request');
    await firstRejected;
    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'loadPaths',
      'abort',
      'loadPaths',
    ]);
    worker.emit({
      operationId: 3,
      payload: { expandedPaths: ['/replacement'], loadedCount: 1 },
      type: 'complete',
    });
    await expect(replacement).resolves.toMatchObject({ expandedPaths: ['/replacement'] });
    expect(replacementSignal?.aborted).toBe(false);
    held.resolve([{ children: [], path: '/replacement' }]);
    await flushMicrotasks();
    expect(worker.postedMessages.filter((message) => message.type === 'loadResult')).toEqual([
      {
        payload: { children: [], path: '/replacement', requestId: 'replacement-load' },
        type: 'loadResult',
      },
    ]);
    port.terminate();
  });

  it('does not send a superseded command after abort posting starts a replacement', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const first = port.loadPaths(['/first']);
    const firstRejected = expect(first).rejects.toThrow('Operation aborted by new request');
    let replacement: ReturnType<typeof port.loadPaths> | undefined;
    vi.spyOn(worker, 'postMessage').mockImplementationOnce((message) => {
      worker.postedMessages.push(message);
      replacement = port.loadPaths(['/replacement']);
    });
    await expect(port.loadSubtree('/second')).rejects.toThrow('Operation aborted by new request');
    await firstRejected;
    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'loadPaths',
      'abort',
      'abort',
      'loadPaths',
    ]);
    worker.emit({
      operationId: 3,
      payload: { expandedPaths: [], loadedCount: 1 },
      type: 'complete',
    });
    await expect(replacement).resolves.toMatchObject({ loadedCount: 1 });
    port.terminate();
  });

  it.each(['signal', 'transport'] as const)(
    'public abort orders %s replacement after remote cancellation',
    async (mode) => {
      const worker = new MockWorker();
      const port = createFileTreeWorkerPort(worker as unknown as Worker);
      const held = createDeferred<BatchLoadResult[]>();
      let replacement: ReturnType<typeof port.loadPaths> | undefined;
      let replacementSignal: AbortSignal | undefined;
      const admit = (): void => {
        replacement = port.loadPaths(['/replacement']);
        worker.emit({
          operationId: 2,
          payload: { paths: ['/replacement'], requestId: 'new' },
          type: 'requestLoad',
        });
      };
      port.onRequestLoad((id, _paths, signal) => {
        if (id === 'new') {
          replacementSignal = signal;
        } else if (mode === 'signal') {
          signal.addEventListener('abort', admit, { once: true });
        }
        return held.promise;
      });
      const first = port.loadPaths(['/first']);
      const rejected = expect(first).rejects.toThrow('Operation aborted');
      worker.emit({
        operationId: 1,
        payload: { paths: ['/first'], requestId: 'held' },
        type: 'requestLoad',
      });
      if (mode === 'transport') {
        vi.spyOn(worker, 'postMessage').mockImplementationOnce((message) => {
          worker.postedMessages.push(message);
          admit();
        });
      }
      port.abort();
      await rejected;
      expect(worker.postedMessages.map((message) => message.type)).toEqual([
        'loadPaths',
        'abort',
        'loadPaths',
      ]);
      expect(replacementSignal?.aborted).toBe(false);
      worker.emit({
        operationId: 2,
        payload: { expandedPaths: [], loadedCount: 1 },
        type: 'complete',
      });
      await expect(replacement).resolves.toMatchObject({ loadedCount: 1 });
      held.resolve([{ children: [], path: '/replacement' }]);
      await flushMicrotasks();
      expect(worker.postedMessages.filter((message) => message.type === 'loadResult')).toEqual([
        { payload: { children: [], path: '/replacement', requestId: 'new' }, type: 'loadResult' },
      ]);
      port.terminate();
    }
  );

  it('cleans captured request loads when public abort posting throws', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const held = createDeferred<BatchLoadResult[]>();
    let signal: AbortSignal | undefined;
    port.onRequestLoad((_id, _paths, value) => {
      signal = value;
      return held.promise;
    });
    const failure = { message: 'abort send failed' };
    const first = port.loadPaths(['/first']);
    const rejected = expect(first).rejects.toThrow('Operation aborted');
    worker.emit({
      operationId: 1,
      payload: { paths: ['/first'], requestId: 'held' },
      type: 'requestLoad',
    });
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      port.abort();
      throw new Error('Expected throw');
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(signal?.aborted).toBe(true);
    await rejected;
    held.resolve([]);
    port.terminate();
  });

  it('termination rejects bulk operations reentered through abort callbacks', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const held = createDeferred<BatchLoadResult[]>();
    let replacement: ReturnType<typeof port.loadPaths> | undefined;
    port.onRequestLoad((_id, _paths, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          replacement = port.loadPaths(['/replacement']);
        },
        { once: true }
      );
      return held.promise;
    });
    const first = port.loadPaths(['/first']);
    const rejected = expect(first).rejects.toThrow('File tree worker port terminated');
    worker.emit({
      operationId: 1,
      payload: { paths: ['/first'], requestId: 'held' },
      type: 'requestLoad',
    });
    port.terminate();
    expect(worker.postedMessages.map((message) => message.type)).toEqual(['loadPaths']);
    await rejected;
    await expect(replacement).rejects.toThrow('File tree worker port terminated');
    await expect(port.loadSubtree('/late')).rejects.toThrow('File tree worker port terminated');
    expect(worker.postedMessages.map((message) => message.type)).toEqual(['loadPaths']);
    held.resolve([]);
  });

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

  it('aborts an active renderer load and suppresses its late correlated result', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const readGate = createDeferred<BatchLoadResult[]>();
    const requestStarted = createDeferred<void>();
    let requestSignal: AbortSignal | undefined;

    port.onRequestLoad(async (_requestId, _paths, ...args: [AbortSignal?]) => {
      requestSignal = args[0];
      requestStarted.resolve();
      return readGate.promise;
    });

    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/dir'], requestId: 'req-late' },
      type: 'requestLoad',
    });
    await requestStarted.promise;

    port.abort();
    expect(requestSignal?.aborted).toBe(true);

    readGate.resolve([
      {
        children: [createDirectoryNode('/root/dir/stale')],
        path: '/root/dir',
      },
    ]);
    await flushMicrotasks();

    expect(worker.postedMessages).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: 'req-late' }),
        type: 'loadResult',
      })
    );
  });

  it('removes a settled renderer load controller from abort ownership', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    let settledSignal: AbortSignal | undefined;

    port.onRequestLoad(async (_requestId, _paths, ...args: [AbortSignal?]) => {
      settledSignal = args[0];
      return [];
    });
    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/dir'], requestId: 'req-settled' },
      type: 'requestLoad',
    });
    await flushMicrotasks();

    expect(settledSignal?.aborted).toBe(false);
    port.abort();
    expect(settledSignal?.aborted).toBe(false);
  });

  it('aborts an active renderer load when a newer bulk operation takes the worker slot', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const readGate = createDeferred<BatchLoadResult[]>();
    const requestStarted = createDeferred<void>();
    let requestSignal: AbortSignal | undefined;

    port.onRequestLoad(async (_requestId, _paths, signal) => {
      requestSignal = signal;
      requestStarted.resolve();
      return readGate.promise;
    });
    const displacedOperation = port.loadPaths(['/root/dir']);
    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/dir'], requestId: 'req-displaced' },
      type: 'requestLoad',
    });
    await requestStarted.promise;

    const activeOperation = port.loadPaths(['/root/other']);
    await expect(displacedOperation).rejects.toThrow('Operation aborted by new request');
    expect(requestSignal?.aborted).toBe(true);

    readGate.resolve([
      {
        children: [createDirectoryNode('/root/dir/stale')],
        path: '/root/dir',
      },
    ]);
    await flushMicrotasks();
    expect(worker.postedMessages).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: 'req-displaced' }),
        type: 'loadResult',
      })
    );

    port.abort();
    await expect(activeOperation).rejects.toThrow('Operation aborted');
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

  it('settles active work before removing listeners and terminating the worker', async () => {
    const worker = new MockWorker();
    const port = createFileTreeWorkerPort(worker as unknown as Worker);
    const onProgress = vi.fn();
    const readGate = createDeferred<BatchLoadResult[]>();
    const requestStarted = createDeferred<void>();
    let requestSignal: AbortSignal | undefined;
    let operationSettlement:
      | { status: 'pending' }
      | { status: 'fulfilled' }
      | { error: unknown; status: 'rejected' } = { status: 'pending' };

    port.onProgress(onProgress);
    port.onRequestLoad(async (_requestId, _paths, signal) => {
      requestSignal = signal;
      requestStarted.resolve();
      return readGate.promise;
    });

    const activeOperation = port.loadPaths(['/root/a']);
    void activeOperation.then(
      () => {
        operationSettlement = { status: 'fulfilled' };
      },
      (error: unknown) => {
        operationSettlement = { error, status: 'rejected' };
      }
    );
    worker.emit({
      operationId: 1,
      payload: { paths: ['/root/a'], requestId: 'req-terminate' },
      type: 'requestLoad',
    });
    await requestStarted.promise;

    port.terminate();
    await flushMicrotasks();

    expect(requestSignal?.aborted).toBe(true);
    expect(operationSettlement).toEqual({
      error: expect.objectContaining({ message: 'File tree worker port terminated' }),
      status: 'rejected',
    });
    expect(worker.terminated).toBe(true);

    worker.emit({
      operationId: 1,
      payload: { currentPath: '/root/a', loaded: 1, total: 1 },
      type: 'progress',
    });
    expect(onProgress).not.toHaveBeenCalled();

    readGate.resolve([
      {
        children: [createDirectoryNode('/root/a/late')],
        path: '/root/a',
      },
    ]);
    await flushMicrotasks();
    expect(worker.postedMessages).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: 'req-terminate' }),
        type: 'loadResult',
      })
    );
  });
});
