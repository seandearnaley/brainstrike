import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from './types';

type WorkerListener = (event: Event) => void;

interface MockWorkerSelf {
  addEventListener: (type: string, listener: WorkerListener) => void;
  listeners: Map<string, WorkerListener[]>;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => Promise<void>) | null;
  postMessage: (message: WorkerToMainMessage) => void;
}

const createMockSelf = (): MockWorkerSelf => {
  const listeners = new Map<string, WorkerListener[]>();
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    }),
    onmessage: null,
    listeners,
  };
};

const createEngineMock = () => ({
  setTree: vi.fn(),
  getTree: vi.fn(() => [{ path: '/root', type: 'directory' }]),
  handleLoadResult: vi.fn(),
  handleLoadError: vi.fn(),
  expandAll: vi.fn(async () => {}),
  loadPaths: vi.fn(async () => {}),
  loadSubtree: vi.fn(async () => {}),
  collapseAll: vi.fn(),
  abort: vi.fn(),
  flattenTree: vi.fn(),
});

const bootstrapWorkerModule = async () => {
  vi.resetModules();
  const selfMock = createMockSelf();
  const engine = createEngineMock();
  const collectExpandedPaths = vi.fn(() => ['/root']);
  const updateNodeChildren = vi.fn(() => [{ path: '/root/updated', type: 'directory' }]);
  const BFSEngine = vi.fn().mockImplementation(function MockBFSEngine() {
    return engine;
  });

  vi.doMock('./bfs-engine', () => ({ BFSEngine }));
  vi.doMock('./tree-operations', () => ({
    collectExpandedPaths,
    updateNodeChildren,
  }));

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    writable: true,
    value: selfMock,
  });

  await import('./file-tree.worker');

  return {
    selfMock,
    engine,
    collectExpandedPaths,
    updateNodeChildren,
    BFSEngine,
  };
};

describe('file-tree.worker', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts ready and registers global error listeners on bootstrap', async () => {
    const { selfMock } = await bootstrapWorkerModule();

    expect(selfMock.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(selfMock.addEventListener).toHaveBeenCalledWith(
      'unhandledrejection',
      expect.any(Function)
    );
    expect(selfMock.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(selfMock.onmessage).toBeTypeOf('function');
  });

  it('handles init/update/message routes and delegates to engine', async () => {
    const { selfMock, engine, collectExpandedPaths, updateNodeChildren } =
      await bootstrapWorkerModule();
    const onMessage = selfMock.onmessage;

    if (!onMessage) {
      throw new Error('worker onmessage was not initialized');
    }

    await onMessage({
      data: {
        type: 'init',
        payload: { rootNodes: [{ path: '/root', type: 'directory' }], folderId: 'folder-1' },
      },
    } as MessageEvent<MainToWorkerMessage>);

    expect(engine.setTree).toHaveBeenCalledWith([{ path: '/root', type: 'directory' }], 'folder-1');
    expect(collectExpandedPaths).toHaveBeenCalled();
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'treeSnapshot',
        payload: expect.objectContaining({ expandedPaths: ['/root'] }),
      })
    );

    await onMessage({
      data: {
        type: 'loadResult',
        payload: { path: '/root', children: [{ path: '/root/a', type: 'directory' }] },
      },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.handleLoadResult).toHaveBeenCalledWith('/root', [
      { path: '/root/a', type: 'directory' },
    ]);

    await onMessage({
      data: { type: 'loadError', payload: { path: '/root', error: 'permission denied' } },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.handleLoadError).toHaveBeenCalledWith('/root', 'permission denied');

    await onMessage({
      data: { type: 'expandAll', payload: { folderId: 'folder-1' } },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.expandAll).toHaveBeenCalledTimes(1);

    await onMessage({
      data: { type: 'loadPaths', payload: { paths: ['/root/a'] } },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.loadPaths).toHaveBeenCalledWith(['/root/a']);

    await onMessage({
      data: { type: 'loadSubtree', payload: { startPath: '/root/a' } },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.loadSubtree).toHaveBeenCalledWith('/root/a');

    await onMessage({
      data: { type: 'collapseAll' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.collapseAll).toHaveBeenCalledTimes(1);

    await onMessage({
      data: { type: 'abort' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.abort).toHaveBeenCalledTimes(1);

    await onMessage({
      data: {
        type: 'updateTree',
        payload: {
          path: '/root',
          children: [{ path: '/root/new', type: 'directory' }],
          loadState: 'loaded',
        },
      },
    } as MessageEvent<MainToWorkerMessage>);
    expect(updateNodeChildren).toHaveBeenCalled();
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'childrenLoaded',
        payload: expect.objectContaining({ path: '/root', loadState: 'loaded' }),
      })
    );

    await onMessage({
      data: { type: 'toggleExpand', payload: { path: '/root' } },
    } as MessageEvent<MainToWorkerMessage>);

    await onMessage({
      data: { type: 'flattenTree', payload: { expandedPaths: ['/root'] } },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.flattenTree).toHaveBeenCalledWith(['/root']);

    await onMessage({
      data: { type: 'unknown-type' as never },
    } as MessageEvent<MainToWorkerMessage>);
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ message: 'Unknown message type: unknown-type' }),
      })
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('posts an error payload when handler execution throws', async () => {
    const { selfMock, engine } = await bootstrapWorkerModule();
    const onMessage = selfMock.onmessage;
    if (!onMessage) {
      throw new Error('worker onmessage was not initialized');
    }

    engine.expandAll.mockRejectedValueOnce(new Error('expand failed'));

    await onMessage({
      data: { type: 'expandAll', payload: { folderId: 'folder-1' } },
    } as MessageEvent<MainToWorkerMessage>);

    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        payload: { message: 'expand failed' },
      })
    );
  });

  it('handles global error and unhandled rejection events', async () => {
    const { selfMock } = await bootstrapWorkerModule();
    const onError = selfMock.listeners.get('error')?.[0];
    const onUnhandledRejection = selfMock.listeners.get('unhandledrejection')?.[0];

    if (!(onError && onUnhandledRejection)) {
      throw new Error('global listeners were not registered');
    }

    onError({
      type: 'error',
      message: 'boom',
      filename: 'worker.js',
      lineno: 10,
      colno: 4,
    } as ErrorEvent);

    onUnhandledRejection({
      reason: new Error('rejected promise'),
    } as PromiseRejectionEvent);

    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        payload: { message: 'global error: boom' },
      })
    );
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        payload: { message: 'unhandledrejection: rejected promise' },
      })
    );
  });
});
