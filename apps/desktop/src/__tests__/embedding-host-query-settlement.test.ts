import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostStatus,
} from '../embedding-host-shared';

const fixture = vi.hoisted(() => ({
  callbacks: null as unknown as {
    onDidFailLoad: (context: {
      errorCode: number;
      errorDescription: string;
      message: string;
      url: string;
    }) => void;
    onRenderProcessGone: (context: {
      message: string;
      reason: string;
      exitCode: number;
      window: unknown;
    }) => void;
    onWindowClosed: () => void;
  },
  lifecycle: null as unknown as {
    ensureStarted: () => Promise<EmbeddingHostStatus>;
    getHostWindow: () => unknown;
    getStatus: () => EmbeddingHostStatus;
    setStatus: (status: EmbeddingHostStatus) => void;
    waitForStatus: ReturnType<typeof vi.fn>;
    clearHostWindow: ReturnType<typeof vi.fn>;
    destroyHostWindow: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
}));
vi.mock('electron', () => ({ powerSaveBlocker: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockLifecycle(
    options: typeof fixture.callbacks
  ): typeof fixture.lifecycle {
    fixture.callbacks = options;
    return fixture.lifecycle;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';
import {
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingErrorReport,
} from '../embedding-host-shared';

const queryCancellation = createEmbeddingHostQueryCancellationError;

const QUERY = {
  dimensions: 384,
  inferencePlan: {
    device: 'wasm' as const,
    dimensions: 384 as const,
    dtype: 'q8' as const,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  },
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'native:queries',
  query: 'held query',
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};
const failureCauses = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(failureCauses) : [error];

describe('query transport physical settlement', () => {
  let window: EventEmitter & {
    isDestroyed: () => boolean;
    destroy: ReturnType<typeof vi.fn<() => void>>;
    webContents: EventEmitter & { id: number; send: ReturnType<typeof vi.fn> };
  };
  let manager: EmbeddingHostManager;
  let request: EmbeddingHostQueryEmbeddingRequest;
  beforeEach(() => {
    vi.useFakeTimers();
    const status: EmbeddingHostStatus = {
      active: false,
      lastError: null,
      runtimeId: 'query-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    };
    window = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { id: 91, send: vi.fn() }),
    });
    fixture.lifecycle = {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(() => window.destroy()),
      dispose: vi.fn(),
      ensureStarted: async () => fixture.lifecycle.getStatus(),
      getHostWindow: () => window,
      getStatus: () => status,
      setStatus: (next) => Object.assign(status, next),
      waitForStatus: vi.fn(),
    };
    manager = new EmbeddingHostManager({ platform: 'linux' });
  });
  afterEach(() => vi.useRealTimers());
  const start = async (
    signal?: AbortSignal
  ): Promise<{ outcome: Promise<unknown>; settled: ReturnType<typeof vi.fn> }> => {
    const settled = vi.fn();
    const outcome = manager.queryEmbedding(QUERY, signal ? { signal } : undefined).then(
      (value) => {
        settled();
        return value;
      },
      (error: unknown) => {
        settled();
        return error;
      }
    );
    await flush();
    request = window.webContents.send.mock.calls[0]?.[1] as EmbeddingHostQueryEmbeddingRequest;
    expect(request.channel).toBe('query-embedding');
    return { outcome, settled };
  };
  const complete = (): void =>
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'query-embedding-result',
      payload: { embedding: Array.from({ length: 384 }, () => 0.1) },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'result',
    });
  it.each([new Error('caller stopped'), 'caller reason', { source: 'caller' }])(
    'retains an aborted request until the held terminal response, preserving %j',
    async (reason) => {
      const controller = new AbortController();
      const { outcome, settled } = await start(controller.signal);
      const inference = Promise.withResolvers<void>();
      const physical = inference.promise.then(complete);
      controller.abort(reason);
      await flush();
      expect(settled).not.toHaveBeenCalled();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
      manager.acceptQueryEmbeddingResponseReport(
        92,
        createEmbeddingHostQueryEmbeddingErrorReport(request, queryCancellation())
      );
      manager.acceptQueryEmbeddingResponseReport(
        91,
        createEmbeddingHostQueryEmbeddingErrorReport(
          { ...request, runtimeId: 'stale' },
          queryCancellation()
        )
      );
      await flush();
      expect(settled).not.toHaveBeenCalled();
      inference.resolve();
      await physical;
      await expect(outcome).resolves.toBe(reason);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
      expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    }
  );
  it('keeps an independent renderer failure alongside caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(request, new Error('device failed'))
    );
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: 'device failed' }),
    ]);
  });
  it('treats the exact renderer cancellation code as a joined caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(request, queryCancellation())
    );
    await expect(outcome).resolves.toBe(reason);
  });
  it('keeps an independent AbortError instead of classifying by its name', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(
        request,
        new DOMException('independent device abort', 'AbortError')
      )
    );
    expect(((await outcome) as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: 'independent device abort', name: 'AbortError' }),
    ]);
  });
  // Lifecycle redesign PR D (R2): a slow cancel acknowledgement is load; no timer stops the host.
  it('joins a cancel the host acknowledges after 12 s, and never stops the host', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(request, queryCancellation())
    );
    await expect(outcome).resolves.toBe(reason);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('refuses only a query past its bound, typed, and keeps the host running for the next', async () => {
    const { outcome, settled } = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    expect(await outcome).toMatchObject({
      failure: { category: 'timeout', code: 'embedding-host.query-timeout', kind: 'refusal' },
    });
    expect(window.webContents.send).toHaveBeenCalledWith(
      'embedding-host:query-embedding-cancel',
      expect.objectContaining({ requestId: request.requestId })
    );
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);

    window.webContents.send.mockClear();
    const next = await start();
    complete();
    await expect(next.outcome).resolves.toHaveLength(384);
  });
  it('retires the host at once when cancellation delivery fails and keeps both causes', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    controller.abort(reason);
    const error = await outcome;
    expect(window.destroy).toHaveBeenCalledOnce();
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({
        message: 'Embedding host query cancellation could not be sent.',
      }),
    ]);
  });
  // ADR-0031: stopping the hidden host is destroying its window; nothing waits on its renderer.
  it('stops a host whose renderer never answers at once, rejecting its in-flight query', async () => {
    const { outcome, settled } = await start();
    const stop = manager.stop();
    await flush();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('stopped') })
    );
    await expect(stop).resolves.toMatchObject({ state: 'stopped' });
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('settles a caller cancellation only after an actual renderer exit, retaining crash evidence', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    controller.abort(reason);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    fixture.callbacks.onRenderProcessGone({
      exitCode: 1,
      message: 'renderer crashed',
      reason: 'crashed',
      window,
    });
    const error = await outcome;
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: expect.stringContaining('renderer crashed') }),
    ]);
  });
  it('retains cancellation when the cancel send synchronously delivers a terminal response', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-cancel') {
        complete();
      }
    });
    controller.abort(reason);
    await expect(outcome).resolves.toBe(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('refuses a timed-out query with its undeliverable cancel, and never stops the host', async () => {
    const { outcome, settled } = await start();
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    const error = await outcome;
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'embedding-host.query-timeout' }),
      }),
      expect.objectContaining({
        message: 'Embedding host query cancellation could not be sent.',
      }),
    ]);
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
  });
  it('retires the host at once when the initial request send fails', async () => {
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-request') {
        throw new Error('request IPC failed');
      }
    });
    const { outcome } = await start();
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('could not be sent') })
    );
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('retains malformed result evidence during caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'query-embedding-result',
      payload: { embedding: [1] },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'result',
    });
    expect(((await outcome) as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: expect.stringContaining('dimensions') }),
    ]);
  });
  it('rejects active query work when reset destroys the host', async () => {
    const { outcome } = await start();
    await manager.reset();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('reset') })
    );
  });
  it('rejects active query work when restart destroys the host', async () => {
    const { outcome } = await start();
    await manager.destroyAndRestart();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('restarted') })
    );
  });
  it('shutdown destroys the host at once and rejects its work', async () => {
    const { outcome } = await start();
    await manager.dispose();
    expect(window.destroy).toHaveBeenCalled();
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(await outcome).toBeInstanceOf(Error);
  });
  it('shutdown settles beside an ordinary Stop already underway', async () => {
    const { outcome } = await start();
    const stop = manager.stop();
    const dispose = manager.dispose();
    await Promise.all([stop, dispose]);
    expect(await outcome).toBeInstanceOf(Error);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('admits a replacement at once after Stop destroys a host that never answered a cancel', async () => {
    const reason = new Error('caller stopped');
    const controller = new AbortController();
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    // A cancel the host never answers holds the host until an explicit Stop retires it.
    await manager.stop();
    await expect(outcome).resolves.toBe(reason);
    await expect(manager.ensureStarted()).resolves.toBeDefined();
  });
  it('stops a host whose window is already destroyed, rejecting its work', async () => {
    const { outcome } = await start();
    window.isDestroyed = () => true;
    await manager.stop();
    expect(await outcome).toBeInstanceOf(Error);
  });
  it('retains aborted capacity until every matching terminal response', async () => {
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const reasons = controllers.map((_, index) => new Error(`caller ${index} stopped`));
    const outcomes = controllers.map((controller) =>
      manager.queryEmbedding(QUERY, { signal: controller.signal }).catch((error: unknown) => error)
    );
    await flush();
    const requests = window.webContents.send.mock.calls.map(
      (call) => call[1] as EmbeddingHostQueryEmbeddingRequest
    );
    controllers.forEach((controller, index) => {
      controller.abort(reasons[index]);
    });
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(8);
    const sentCount = window.webContents.send.mock.calls.length;
    await expect(manager.queryEmbedding(QUERY)).rejects.toThrow(
      '8 query embedding requests in flight'
    );
    expect(window.webContents.send).toHaveBeenCalledTimes(sentCount);
    for (const pending of requests) {
      manager.acceptQueryEmbeddingResponseReport(
        91,
        createEmbeddingHostQueryEmbeddingErrorReport(pending, queryCancellation())
      );
    }
    await expect(Promise.all(outcomes)).resolves.toEqual(reasons);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it.each([false, true])(
    'preserves a destruction failure in every outcome (caller aborted: %s)',
    async (aborted) => {
      const controller = new AbortController();
      const reason = { source: 'caller' };
      const { outcome } = await start(controller.signal);
      const destructionFailure = new Error('initial destruction failed');
      window.destroy.mockImplementationOnce(() => {
        throw destructionFailure;
      });
      if (aborted) {
        controller.abort(reason);
      }
      const stop = manager.stop().catch((error: unknown) => error);
      expect(failureCauses(await outcome)).toEqual(
        aborted ? [reason, destructionFailure] : [destructionFailure]
      );
      expect(failureCauses(await stop)).toEqual([destructionFailure]);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );
  it('retries a destruction that failed on the next restart, reporting each failure', async () => {
    const { outcome } = await start();
    const destructionFailure = new Error('first destruction failed');
    const retryFailure = new Error('retry destruction failed');
    window.destroy
      .mockImplementationOnce(() => {
        throw destructionFailure;
      })
      .mockImplementationOnce(() => {
        throw retryFailure;
      });
    const stop = manager.stop().catch((error: unknown) => error);
    expect(failureCauses(await stop)).toEqual([destructionFailure]);
    expect(failureCauses(await outcome)).toEqual([destructionFailure]);
    const retry = manager.destroyAndRestart().catch((error: unknown) => error);
    expect(failureCauses(await retry)).toEqual([retryFailure]);
    expect(window.destroy).toHaveBeenCalledTimes(2);
    await expect(manager.destroyAndRestart()).resolves.toBeDefined();
    expect(window.destroy).toHaveBeenCalledTimes(3);
  });
  it('rejects work with a renderer exit that precedes Stop, and Stop still destroys the host', async () => {
    const { outcome } = await start();
    fixture.callbacks.onRenderProcessGone({
      exitCode: 1,
      message: 'renderer exited before Stop',
      reason: 'crashed',
      window,
    });
    expect(failureCauses(await outcome)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('renderer exited before Stop') }),
    ]);
    await expect(manager.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(window.destroy).toHaveBeenCalledOnce();
  });
  it('returns a normal response only once the held inference completes', async () => {
    const { outcome, settled } = await start();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    complete();
    expect(await outcome).toEqual(Array.from({ length: 384 }, () => 0.1));
  });
  it('retires a host whose load failed at once, rejecting the query', async () => {
    const { outcome } = await start();
    fixture.callbacks.onDidFailLoad({
      errorCode: -2,
      errorDescription: 'load failed',
      message: 'query host load failed',
      url: 'app://host',
    });
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(failureCauses(await outcome)).toContainEqual(
      expect.objectContaining({ message: 'query host load failed' })
    );
  });
  it('rejects query and document work alike when Stop fails to destroy the host', async () => {
    const { outcome } = await start();
    const document = manager
      .documentEmbeddings({ ...QUERY, texts: ['document sibling'] })
      .catch((error: unknown) => error);
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    const destroyFailure = new Error('shared destruction failed');
    window.destroy.mockImplementationOnce(() => {
      throw destroyFailure;
    });
    const stop = manager.stop().catch((error: unknown) => error);
    expect(failureCauses(await outcome)).toEqual([destroyFailure]);
    expect(failureCauses(await document)).toEqual([destroyFailure]);
    expect(failureCauses(await stop)).toEqual([destroyFailure]);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('refuses a query and a document sibling past their windows each alone, never stopping the host', async () => {
    const { outcome } = await start();
    const document = manager
      .documentEmbeddings({ ...QUERY, texts: ['document sibling'] })
      .catch((error: unknown) => error);
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(await outcome).toMatchObject({
      failure: { code: 'embedding-host.query-timeout', kind: 'refusal' },
    });
    expect(await document).toMatchObject({ code: 'embedding-host.unresponsive' });
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('settles a cancelled query when closed makes BrowserWindow webContents inaccessible', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const contents = window.webContents;
    let destroyed = false;
    Object.defineProperty(window, 'webContents', {
      configurable: true,
      get: () => {
        if (destroyed) {
          throw new TypeError('Object has been destroyed');
        }
        return contents;
      },
    });
    window.isDestroyed = () => destroyed;
    window.destroy.mockImplementation(() => {
      destroyed = true;
      window.emit('closed');
    });
    const { outcome, settled } = await start(controller.signal);
    controller.abort(reason);
    // A cancel the host never answers holds the host until an explicit Stop retires it.
    await expect(manager.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(settled).toHaveBeenCalledOnce();
    await expect(outcome).resolves.toBe(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(contents.listenerCount('render-process-gone')).toBe(0);
    expect(window.listenerCount('closed')).toBe(0);
  });
  it('retires an errored host before a new request can replace its unresolved inference owner', async () => {
    const { outcome } = await start();
    const admission = vi.fn(async () => fixture.lifecycle.getStatus());
    fixture.lifecycle.ensureStarted = admission;
    fixture.lifecycle.setStatus({
      ...fixture.lifecycle.getStatus(),
      lastError: 'owned renderer failure',
      state: 'error',
    });
    const replacement = manager.queryEmbedding(QUERY).catch((error: unknown) => error);
    expect(await replacement).toMatchObject({ message: 'owned renderer failure' });
    expect(await outcome).toMatchObject({ message: 'owned renderer failure' });
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(admission).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
});
