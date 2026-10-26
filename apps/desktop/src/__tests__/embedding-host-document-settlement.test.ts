import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingHostDocumentEmbeddingsRequest,
  EmbeddingHostStatus,
} from '../embedding-host-shared';

const fixture = vi.hoisted(() => ({
  callbacks: null as unknown as {
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
  createEmbeddingHostDocumentCancellationError,
  createEmbeddingHostDocumentEmbeddingsErrorReport,
  createEmbeddingHostRuntimeStoppedError,
  EMBEDDING_HOST_RUNTIME_STOPPED_CODE,
} from '../embedding-host-shared';
import { EMBEDDING_HOST_UNRESPONSIVE_CODE } from '../embedding-host-unresponsive';

const DOCUMENT = {
  dimensions: 384,
  inferencePlan: {
    device: 'wasm' as const,
    dimensions: 384 as const,
    dtype: 'q8' as const,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  },
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'native:documents',
  texts: ['held document'],
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};
const failureCauses = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(failureCauses) : [error];

describe('document transport physical settlement', () => {
  let window: EventEmitter & {
    isDestroyed: () => boolean;
    destroy: ReturnType<typeof vi.fn<() => void>>;
    webContents: EventEmitter & { id: number; send: ReturnType<typeof vi.fn> };
  };
  let manager: EmbeddingHostManager;
  let request: EmbeddingHostDocumentEmbeddingsRequest;
  beforeEach(() => {
    vi.useFakeTimers();
    const status: EmbeddingHostStatus = {
      active: false,
      lastError: null,
      runtimeId: 'document-runtime',
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
    const outcome = manager.documentEmbeddings(DOCUMENT, signal ? { signal } : undefined).then(
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
    request = window.webContents.send.mock.calls[0]?.[1] as EmbeddingHostDocumentEmbeddingsRequest;
    expect(request.channel).toBe('document-embeddings');
    return { outcome, settled };
  };
  const complete = (): void =>
    manager.acceptDocumentEmbeddingsResponseReport(91, {
      channel: 'document-embeddings-result',
      payload: { embeddings: [Array.from({ length: 384 }, () => 0.1)] },
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
      manager.acceptDocumentEmbeddingsResponseReport(
        92,
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          request,
          createEmbeddingHostDocumentCancellationError()
        )
      );
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          { ...request, runtimeId: 'stale' },
          createEmbeddingHostDocumentCancellationError()
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
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(request, new Error('device failed'))
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
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        createEmbeddingHostDocumentCancellationError()
      )
    );
    await expect(outcome).resolves.toBe(reason);
  });
  it('keeps an independent AbortError instead of classifying by its name', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        new DOMException('independent device abort', 'AbortError')
      )
    );
    expect(((await outcome) as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: 'independent device abort', name: 'AbortError' }),
    ]);
  });
  it("joins a caller cancellation that the host's own Stop ended first", async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    controller.abort(reason);
    // Shutdown retires the host beside cooperative cancellation; its Stop answers first.
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        createEmbeddingHostRuntimeStoppedError()
      )
    );
    await expect(outcome).resolves.toBe(reason);
  });
  it('reports a host Stop as a failure to a caller that did not cancel', async () => {
    const { outcome } = await start();
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        createEmbeddingHostRuntimeStoppedError()
      )
    );
    expect(await outcome).toEqual(
      expect.objectContaining({ code: EMBEDDING_HOST_RUNTIME_STOPPED_CODE, name: 'AbortError' })
    );
  });
  // Lifecycle redesign PR D (R2): a slow cancel acknowledgement is load; no timer stops the host.
  it('joins a cancel the host acknowledges after 12 s, and never stops the host', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome, settled } = await start(controller.signal);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({ payload: expect.objectContaining({ action: 'stop' }) })
    );
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        createEmbeddingHostDocumentCancellationError()
      )
    );
    await expect(outcome).resolves.toBe(reason);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  // Lifecycle redesign PR D: the silent batch is refused typed (BST-2104 Retry restarts the host);
  // the window itself never stops the host.
  it('refuses a silent batch as unresponsive without stopping the host', async () => {
    const { outcome, settled } = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    expect(await outcome).toEqual(
      expect.objectContaining({
        code: EMBEDDING_HOST_UNRESPONSIVE_CODE,
        message: expect.stringContaining('It sent no progress for 1 min'),
      })
    );
    expect(window.webContents.send).toHaveBeenCalledWith(
      'embedding-host:document-embeddings-cancel',
      expect.objectContaining({ requestId: request.requestId })
    );
    expect(window.webContents.send).not.toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({ payload: expect.objectContaining({ action: 'stop' }) })
    );
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('retires the host at once when cancellation delivery fails and keeps both causes', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const { outcome } = await start(controller.signal);
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:document-embeddings-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    controller.abort(reason);
    const error = await outcome;
    expect(window.destroy).toHaveBeenCalledOnce();
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({
        message: 'Embedding host document cancellation could not be sent.',
      }),
    ]);
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
      if (event === 'embedding-host:document-embeddings-cancel') {
        complete();
      }
    });
    controller.abort(reason);
    await expect(outcome).resolves.toBe(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('refuses a silent batch with its undeliverable cancel, and never stops the host', async () => {
    const { outcome, settled } = await start();
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:document-embeddings-cancel') {
        throw new Error('cancel IPC failed');
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    const error = await outcome;
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: EMBEDDING_HOST_UNRESPONSIVE_CODE }),
      expect.objectContaining({
        message: 'Embedding host document cancellation could not be sent.',
      }),
    ]);
    expect(fixture.lifecycle.waitForStatus).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
  });
  it('retires the host at once when the initial request send fails', async () => {
    window.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:document-embeddings-request') {
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
    manager.acceptDocumentEmbeddingsResponseReport(91, {
      channel: 'document-embeddings-result',
      payload: { embeddings: [[1]] },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'result',
    });
    expect(((await outcome) as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({ message: expect.stringContaining('count or dimensions') }),
    ]);
  });
  it('rejects active document work when reset destroys the host', async () => {
    const { outcome } = await start();
    await manager.reset();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining('reset') })
    );
  });
  it('rejects active document work when restart destroys the host', async () => {
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
      manager
        .documentEmbeddings(DOCUMENT, { signal: controller.signal })
        .catch((error: unknown) => error)
    );
    await flush();
    const requests = window.webContents.send.mock.calls.map(
      (call) => call[1] as EmbeddingHostDocumentEmbeddingsRequest
    );
    controllers.forEach((controller, index) => {
      controller.abort(reasons[index]);
    });
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(8);
    const sentCount = window.webContents.send.mock.calls.length;
    await expect(manager.documentEmbeddings(DOCUMENT)).rejects.toThrow(
      '8 inference requests in flight'
    );
    expect(window.webContents.send).toHaveBeenCalledTimes(sentCount);
    for (const pending of requests) {
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          pending,
          createEmbeddingHostDocumentCancellationError()
        )
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
    expect(await outcome).toEqual([Array.from({ length: 384 }, () => 0.1)]);
  });
});
