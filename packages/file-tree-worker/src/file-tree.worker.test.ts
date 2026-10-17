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
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    }),
    listeners,
    onmessage: null,
    postMessage: vi.fn(),
  };
};

const createEngineMock = () => ({
  abort: vi.fn(),
  applyDirectoryChildrenUpdate: vi.fn(),
  collapseAll: vi.fn(),
  expandAll: vi.fn(async () => {}),
  flattenTree: vi.fn(),
  getTree: vi.fn(() => [{ path: '/root', type: 'directory' }]),
  handleLoadError: vi.fn(),
  handleLoadResult: vi.fn(),
  loadPaths: vi.fn(async () => {}),
  loadSubtree: vi.fn(async () => {}),
  setTree: vi.fn(() => true),
});

const bootstrapWorkerModule = async () => {
  vi.resetModules();
  const selfMock = createMockSelf();
  const engine = createEngineMock();
  const collectExpandedPaths = vi.fn(() => ['/root']);
  const BFSEngine = vi.fn().mockImplementation(function MockBFSEngine() {
    return engine;
  });

  vi.doMock('./bfs-engine', () => ({ BFSEngine }));
  vi.doMock('./tree-operations', () => ({
    collectExpandedPaths,
  }));

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: selfMock,
    writable: true,
  });

  await import('./file-tree.worker');

  return {
    BFSEngine,
    collectExpandedPaths,
    engine,
    selfMock,
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
    const { selfMock, engine, collectExpandedPaths } = await bootstrapWorkerModule();
    const onMessage = selfMock.onmessage;

    if (!onMessage) {
      throw new Error('worker onmessage was not initialized');
    }

    await onMessage({
      data: {
        payload: { folderId: 'folder-1', rootNodes: [{ path: '/root', type: 'directory' }] },
        type: 'init',
      },
    } as MessageEvent<MainToWorkerMessage>);

    expect(engine.setTree).toHaveBeenCalledWith([{ path: '/root', type: 'directory' }], 'folder-1');
    expect(collectExpandedPaths).toHaveBeenCalled();
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ expandedPaths: ['/root'] }),
        type: 'treeSnapshot',
      })
    );

    await onMessage({
      data: {
        payload: {
          children: [{ path: '/root/a', type: 'directory' }],
          path: '/root',
          requestId: 'request-1',
        },
        type: 'loadResult',
      },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.handleLoadResult).toHaveBeenCalledWith(
      '/root',
      [{ path: '/root/a', type: 'directory' }],
      'request-1'
    );

    await onMessage({
      data: {
        payload: { error: 'permission denied', path: '/root', requestId: 'request-2' },
        type: 'loadError',
      },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.handleLoadError).toHaveBeenCalledWith('/root', 'permission denied', 'request-2');

    await onMessage({
      data: { operationId: 1, payload: { folderId: 'folder-1' }, type: 'expandAll' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.expandAll).toHaveBeenCalledWith(1);

    await onMessage({
      data: { operationId: 2, payload: { paths: ['/root/a'] }, type: 'loadPaths' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.loadPaths).toHaveBeenCalledWith(['/root/a'], 2);

    await onMessage({
      data: { operationId: 3, payload: { startPath: '/root/a' }, type: 'loadSubtree' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.loadSubtree).toHaveBeenCalledWith('/root/a', 3);

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
        payload: {
          children: [{ path: '/root/new', type: 'directory' }],
          loadState: 'loaded',
          path: '/root',
        },
        type: 'updateTree',
      },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.applyDirectoryChildrenUpdate).toHaveBeenCalledWith(
      '/root',
      [{ path: '/root/new', type: 'directory' }],
      'loaded'
    );

    await onMessage({
      data: { payload: { path: '/root' }, type: 'toggleExpand' },
    } as MessageEvent<MainToWorkerMessage>);

    await onMessage({
      data: { payload: { expandedPaths: ['/root'] }, type: 'flattenTree' },
    } as MessageEvent<MainToWorkerMessage>);
    expect(engine.flattenTree).toHaveBeenCalledWith(['/root']);

    // @ts-expect-error -- exercise refusal of an unrecognized wire message at the typed handler.
    await onMessage(new MessageEvent('message', { data: { type: 'unknown-type' } }));
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ message: 'Unknown message type: unknown-type' }),
        type: 'error',
      })
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('emits no tree-replaced signal when the engine skips an identical init', async () => {
    const { selfMock, engine, collectExpandedPaths } = await bootstrapWorkerModule();
    const onMessage = selfMock.onmessage;
    if (!onMessage) {
      throw new Error('worker onmessage was not initialized');
    }

    engine.setTree.mockReturnValueOnce(false);

    await onMessage({
      data: {
        payload: { folderId: 'folder-1', rootNodes: [{ path: '/root', type: 'directory' }] },
        type: 'init',
      },
    } as MessageEvent<MainToWorkerMessage>);

    expect(engine.setTree).toHaveBeenCalledTimes(1);
    // No snapshot to clone across the port, and no 'tree initialized' log to act on.
    expect(collectExpandedPaths).not.toHaveBeenCalled();
    expect(selfMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'treeSnapshot' })
    );
    expect(selfMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'tree initialized' })
    );
    // Only the bootstrap 'ready' message.
    expect(selfMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it('posts an error payload when handler execution throws', async () => {
    const { selfMock, engine } = await bootstrapWorkerModule();
    const onMessage = selfMock.onmessage;
    if (!onMessage) {
      throw new Error('worker onmessage was not initialized');
    }

    engine.expandAll.mockRejectedValueOnce(new Error('expand failed'));

    await onMessage({
      data: { operationId: 1, payload: { folderId: 'folder-1' }, type: 'expandAll' },
    } as MessageEvent<MainToWorkerMessage>);

    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { message: 'expand failed' },
        type: 'error',
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
      colno: 4,
      filename: 'worker.js',
      lineno: 10,
      message: 'boom',
      type: 'error',
    } as ErrorEvent);

    onUnhandledRejection({
      reason: new Error('rejected promise'),
    } as PromiseRejectionEvent);

    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { message: 'global error: boom' },
        type: 'error',
      })
    );
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { message: 'unhandledrejection: rejected promise' },
        type: 'error',
      })
    );
  });
});
