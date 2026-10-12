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
    onRenderProcessGone: (context: { message: string; reason: string; exitCode: number }) => void;
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
  let stopAck: ReturnType<typeof Promise.withResolvers<EmbeddingHostStatus>>;
  beforeEach(() => {
    vi.useFakeTimers();
    const status: EmbeddingHostStatus = {
      active: false,
      lastError: null,
      runtimeId: 'query-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    };
    stopAck = Promise.withResolvers<EmbeddingHostStatus>();
    void stopAck.promise.catch(() => undefined);
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
      waitForStatus: vi.fn(() => stopAck.promise),
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
  it('escalates a non-cooperative cancellation into the existing Stop join', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.lifecycle.waitForStatus).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(settled).not.toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    await expect(outcome).resolves.toBe(reason);
  });
  it('keeps a timed-out request owned until Stop physically joins', async () => {
    const { outcome, settled } = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.lifecycle.waitForStatus).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('timed out after 60000ms') })
    );
  });
  it('joins retirement after cancellation delivery fails and keeps both causes', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    controller.abort(reason);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(fixture.lifecycle.waitForStatus).toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    const error = await outcome;
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({
        message: 'Embedding host query cancellation could not be sent.',
      }),
    ]);
  });
  it('retains a request after Stop failure until the destroyed window actually closes', async () => {
    const { outcome, settled } = await start();
    const stopError = new Error('Stop join failed');
    await vi.advanceTimersByTimeAsync(60_000);
    stopAck.reject(stopError);
    await flush();
    expect(window.destroy).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    window.emit('closed');
    const error = await outcome;
    expect((error as AggregateError).errors).toContain(stopError);
  });
  it('retains a query through explicit Stop until its acknowledgement', async () => {
    const { outcome, settled } = await start();
    const stop = manager.stop();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    await stop;
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('stopped') })
    );
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
  it('retains a timeout and cancellation delivery failure through physical Stop', async () => {
    const { outcome, settled } = await start();
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    const error = await outcome;
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('timed out after 60000ms') }),
      expect.objectContaining({
        message: 'Embedding host query cancellation could not be sent.',
      }),
    ]);
  });
  it('joins physical Stop when the initial request send fails', async () => {
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-request') {
        throw new Error('request IPC failed');
      }
    });
    const { outcome, settled } = await start();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('could not be sent') })
    );
  });
  it('keeps a late independent failure during timeout retirement', async () => {
    const { outcome, settled } = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(request, new Error('device failed'))
    );
    await flush();
    expect(settled).not.toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    expect(((await outcome) as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('timed out after 60000ms') }),
      expect.objectContaining({ message: 'device failed' }),
    ]);
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
  it('joins reset before rejecting active query work', async () => {
    const { outcome, settled } = await start();
    const reset = manager.reset();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'running' });
    await reset;
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('reset') })
    );
  });
  it('joins restart destruction before rejecting active query work', async () => {
    const { outcome, settled } = await start();
    const restart = manager.destroyAndRestart();
    await flush();
    expect(window.destroy).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    window.emit('closed');
    await restart;
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('restarted') })
    );
  });
  it('joins shutdown using its original 3s Stop budget', async () => {
    const { outcome, settled } = await start();
    const dispose = manager.dispose();
    await flush();
    expect(fixture.lifecycle.waitForStatus).toHaveBeenCalledWith(expect.any(Function), 3000);
    expect(settled).not.toHaveBeenCalled();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    await dispose;
    expect(await outcome).toBeInstanceOf(Error);
  });
  it('keeps shutdown at 3s when an ordinary Stop already owns the host', async () => {
    const { outcome, settled } = await start();
    const stop = manager.stop();
    const dispose = manager.dispose().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3000);
    expect(window.destroy).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    window.emit('closed');
    expect(await dispose).toBeInstanceOf(Error);
    expect(await outcome).toBeInstanceOf(Error);
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    await stop;
  });
  it('does not admit a replacement before a forced retirement closes', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(60_000);
    stopAck.reject(new Error('Stop failed'));
    await flush();
    const started = vi.fn();
    const replacement = manager
      .ensureStarted()
      .then(started)
      .catch((error: unknown) => error);
    await flush();
    expect(started).not.toHaveBeenCalled();
    window.emit('closed');
    expect(await replacement).toBeInstanceOf(Error);
    expect(started).not.toHaveBeenCalled();
    await manager.ensureStarted().then(started);
    expect(started).toHaveBeenCalledOnce();
  });
  it('does not treat isDestroyed as a close event', async () => {
    const { outcome, settled } = await start();
    window.isDestroyed = () => true;
    const stop = manager.stop();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    window.emit('closed');
    await stop;
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
  it('joins forced close when Stop delivery fails after caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    const stopFailure = new Error('Stop IPC failed');
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:command') {
        throw stopFailure;
      }
    });
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(window.destroy).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    window.emit('closed');
    expect(((await outcome) as AggregateError).errors).toEqual([reason, stopFailure]);
  });
  it('keeps a failed destruction owned and retries through the existing restart seam', async () => {
    const { outcome, settled } = await start();
    const destructionFailure = new Error('destroy failed');
    window.destroy.mockImplementationOnce(() => {
      throw destructionFailure;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    stopAck.reject(new Error('Stop failed'));
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    const retry = manager.destroyAndRestart().catch((error: unknown) => error);
    await flush();
    expect(window.destroy).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    window.emit('closed');
    expect(failureCauses(await outcome)).toContain(destructionFailure);
    expect(await retry).toBeInstanceOf(Error);
  });
  it.each([false, true])(
    'preserves Stop and destruction failures after physical close (caller aborted: %s)',
    async (aborted) => {
      const controller = new AbortController();
      const reason = { source: 'caller' };
      const { outcome, settled } = await start(controller.signal);
      const stopFailure = new Error('Stop failed before destruction');
      const destructionFailure = new Error('initial destruction failed');
      window.destroy.mockImplementationOnce(() => {
        throw destructionFailure;
      });
      if (aborted) {
        controller.abort(reason);
      }
      const stop = manager.stop().catch((error: unknown) => error);
      stopAck.reject(stopFailure);
      await flush();
      expect(window.destroy).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
      window.emit('closed');
      expect(failureCauses(await outcome)).toEqual(
        aborted ? [reason, stopFailure, destructionFailure] : [stopFailure, destructionFailure]
      );
      expect(failureCauses(await stop)).toEqual([stopFailure, destructionFailure]);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );
  it.each([false, true])(
    'preserves failed destruction retry in every retirement outcome (caller aborted: %s)',
    async (aborted) => {
      const controller = new AbortController();
      const reason = { source: 'caller' };
      const { outcome, settled } = await start(controller.signal);
      const stopFailure = new Error('Stop failed before retry');
      const destructionFailure = new Error('first destruction failed');
      const retryFailure = new Error('retry destruction failed');
      window.destroy
        .mockImplementationOnce(() => {
          throw destructionFailure;
        })
        .mockImplementationOnce(() => {
          throw retryFailure;
        });
      if (aborted) {
        controller.abort(reason);
      }
      const stop = manager.stop().catch((error: unknown) => error);
      stopAck.reject(stopFailure);
      await flush();
      const retry = manager.destroyAndRestart().catch((error: unknown) => error);
      await flush();
      expect(window.destroy).toHaveBeenCalledTimes(2);
      expect(settled).not.toHaveBeenCalled();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
      window.emit('closed');
      const failures = [stopFailure, destructionFailure, retryFailure];
      expect(failureCauses(await outcome)).toEqual(aborted ? [reason, ...failures] : failures);
      expect(failureCauses(await stop)).toEqual(failures);
      expect(failureCauses(await retry)).toEqual(failures);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );
  it('preserves retirement failures when the renderer exit callback precedes the shared join', async () => {
    const { outcome, settled } = await start();
    const stopFailure = new Error('Stop failed before exit');
    const destructionFailure = new Error('destruction failed before exit');
    window.destroy.mockImplementationOnce(() => {
      throw destructionFailure;
    });
    const stop = manager.stop().catch((error: unknown) => error);
    stopAck.reject(stopFailure);
    await flush();
    fixture.callbacks.onRenderProcessGone({
      exitCode: 1,
      message: 'renderer exited during retirement',
      reason: 'crashed',
    });
    expect(settled).not.toHaveBeenCalled();
    window.webContents.emit('render-process-gone');
    const failures = failureCauses(await outcome);
    expect(failures).toEqual([
      stopFailure,
      destructionFailure,
      expect.objectContaining({ message: 'renderer exited during retirement' }),
    ]);
    expect(failureCauses(await stop)).toEqual(failures);
  });
  it('returns a normal response only once the held inference completes', async () => {
    const { outcome, settled } = await start();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    complete();
    expect(await outcome).toEqual(Array.from({ length: 384 }, () => 0.1));
  });
  it('joins load failure retirement before rejecting the query', async () => {
    const { outcome, settled } = await start();
    fixture.callbacks.onDidFailLoad({
      errorCode: -2,
      errorDescription: 'load failed',
      message: 'query host load failed',
      url: 'app://host',
    });
    await flush();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    window.emit('closed');
    expect(failureCauses(await outcome)).toContainEqual(
      expect.objectContaining({ message: 'query host load failed' })
    );
  });

  it('preserves query and document ownership through shared Stop and failed destruction', async () => {
    const { outcome, settled } = await start();
    const documentSettled = vi.fn();
    const document = manager
      .documentEmbeddings({ ...QUERY, texts: ['document sibling'] })
      .catch((error: unknown) => {
        documentSettled();
        return error;
      });
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    const stopFailure = new Error('shared Stop failed');
    const destroyFailure = new Error('shared destruction failed');
    window.destroy.mockImplementationOnce(() => {
      throw destroyFailure;
    });
    const stop = manager.stop().catch((error: unknown) => error);
    stopAck.reject(stopFailure);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(documentSettled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    window.emit('closed');
    expect(failureCauses(await outcome)).toEqual([stopFailure, destroyFailure]);
    expect(failureCauses(await document)).toEqual([stopFailure, destroyFailure]);
    expect(failureCauses(await stop)).toEqual([stopFailure, destroyFailure]);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });

  it('retains a document sibling until shared query timeout Stop actually joins', async () => {
    const { outcome, settled } = await start();
    const documentSettled = vi.fn();
    const document = manager
      .documentEmbeddings({ ...QUERY, texts: ['document sibling'] })
      .catch((error: unknown) => {
        documentSettled();
        return error;
      });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(documentSettled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    expect(fixture.lifecycle.waitForStatus).toHaveBeenCalledOnce();
    stopAck.resolve({ ...fixture.lifecycle.getStatus(), state: 'stopped' });
    expect(await outcome).toBeInstanceOf(Error);
    expect(await document).toBeInstanceOf(Error);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('settles a timed-out query when closed makes BrowserWindow webContents inaccessible', async () => {
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
    const { outcome, settled } = await start();
    const stopError = new Error('Stop join failed');
    await vi.advanceTimersByTimeAsync(60_000);
    stopAck.reject(stopError);
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    expect(failureCauses(await outcome)).toContain(stopError);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(contents.listenerCount('render-process-gone')).toBe(0);
    expect(window.listenerCount('closed')).toBe(0);
  });

  it('joins an errored host before a new request can replace its unresolved inference owner', async () => {
    const { outcome, settled } = await start();
    const admission = vi.fn(async () => fixture.lifecycle.getStatus());
    fixture.lifecycle.ensureStarted = admission;
    fixture.lifecycle.setStatus({
      ...fixture.lifecycle.getStatus(),
      lastError: 'owned renderer failure',
      state: 'error',
    });
    const replacement = manager.queryEmbedding(QUERY).catch((error: unknown) => error);
    await flush();
    expect(admission).not.toHaveBeenCalled();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    window.emit('closed');
    expect(await replacement).toMatchObject({ message: 'owned renderer failure' });
    expect(await outcome).toMatchObject({ message: 'owned renderer failure' });
    expect(admission).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
});
