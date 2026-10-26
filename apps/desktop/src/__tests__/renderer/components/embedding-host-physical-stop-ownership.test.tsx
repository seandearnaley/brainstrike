// @vitest-environment jsdom
import './embedding-host-foreground-ownership-fixture';
import { EventEmitter } from 'node:events';
import {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { addLogListener } from '@brainstrike/logging';
import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { act } from '@brainstrike/test-utils/react-act';
import { type RenderResult, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import {
  assertEmbeddingHostQueryEmbeddingRequest,
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  createEmbeddingHostQueryEmbeddingCancel,
  EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
} from '../../../embedding-host-shared';
import { registerEmbeddingHostIpcHandlers } from '../../../ipc-embedding-host';
import { DESKTOP_IPC_CHANNELS } from '../../../platform/desktop-ipc-channels';
import { getEmbeddingHostBridge } from '../../../renderer/components/embedding-host-bridge';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import { generateDesktopQueryEmbedding } from '../../../renderer/query-embeddings';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../../window-role';
import { createAllowlistedSenderFrame } from '../../helpers/desktop-ipc-sender-frame-test-allowlist';
import {
  commandListenerRef,
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  ipcHandlers,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  readModelCatalogMock,
  reopenEmbeddingQueueMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  storeState,
} from './embedding-host-foreground-ownership-fixture';

const failureCauses = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(failureCauses) : [error];

const query = {
  dimensions: 2,
  modelId: 'model-a',
  modelKey: 'local:model-a',
  query: 'public queue fixture',
};

async function connectControlledQuery(options?: { cancellationCapability?: boolean }) {
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('Worker', class {});
  storeState.hasHydrated = true;
  readModelCatalogMock.mockResolvedValue({
    models: ['model-a', 'model-b', 'model-c'].map((id) => ({
      capabilities: { defaultDimension: 2 },
      description: '',
      id,
      name: 'Fixture',
      parameters: {},
      providerId: 'local',
    })),
    providers: [],
  });
  const held = Promise.withResolvers<QueueResult>();
  let physicallyActive = false;
  const add = vi.fn<QueueAdapter['add']>(async (_task) => {
    physicallyActive = true;
    try {
      return await held.promise;
    } finally {
      physicallyActive = false;
    }
  });
  const cancel = vi.fn(async () => {});
  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    cancel,
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  registerEmbeddingQueueFactory(() => queue);
  const dispose = vi.spyOn(SimpleEmbeddingService.prototype, 'dispose');
  configureDesktopRendererTarget({
    kind: 'dev-renderer',
    launchMode: 'dev-server',
    url: 'http://localhost',
  });
  const manager = new EmbeddingHostManager({ platform: 'linux' });
  reportStatusMock.mockImplementation((status: unknown) =>
    manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
  );
  reportQueryEmbeddingResponseMock.mockImplementation((response: unknown) =>
    manager.acceptQueryEmbeddingResponseReport(
      hostWindow.webContents.id,
      assertEmbeddingHostQueryEmbeddingResponseReport(response)
    )
  );
  hostWindow.webContents.send.mockImplementation((channel: string, payload: unknown) => {
    if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT) {
      queryEmbeddingListenerRef.current?.(payload);
      return;
    }
    if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT) {
      queryEmbeddingCancelListenerRef.current?.(payload);
      return;
    }
    commandListenerRef.current?.(payload);
  });
  await manager.ensureStarted({ waitForRunning: false });
  if (options?.cancellationCapability === false) {
    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: { ...getEmbeddingHostBridge(), onQueryEmbeddingCancel: undefined },
    });
  }
  const view = render(<EmbeddingHostRuntime />);
  await waitFor(() => expect(manager.getStatus().state).toBe('running'));
  const finish = () =>
    held.resolve({
      id: add.mock.calls[0]?.[0].id ?? 'unstarted',
      metadata: {
        batchSize: 1,
        device: 'webgpu',
        dimensions: 2,
        dtype: 'fp16',
        elapsedMs: 1,
        fallbackApplied: false,
        model: 'model-a',
        pooling: 'mean',
      },
      type: 'result',
      vectors: [Float32Array.from([0.1, 0.2])],
    });
  onTestFinished(async () => {
    finish();
    await act(async () => {});
    view.unmount();
    hostWindow.destroy();
    await manager.dispose();
    resetEmbeddingQueueFactory();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configureDesktopRendererTarget(null);
  });
  return {
    add,
    cancel,
    dispose,
    fail: (error: unknown) => held.reject(error),
    finish,
    isPhysicallyActive: () => physicallyActive,
    manager,
    view,
  };
}

/** Reset destroys the hidden window, its renderer with it, and loads a fresh one. */
async function mountReplacementRenderer(view: RenderResult): Promise<void> {
  await waitFor(() => expect(hostWindow.loadURL).toHaveBeenCalledTimes(2));
  view.unmount();
  const fresh = render(<EmbeddingHostRuntime />);
  onTestFinished(() => fresh.unmount());
}

describe('committed readiness fix physical query ownership controls', () => {
  installEmbeddingHostRuntimeFixture();

  it('joins the visible query IPC promise through the actual hidden service and held queue', async () => {
    const run = await connectControlledQuery();
    const requester = Object.assign(new EventEmitter(), { id: 901, send: vi.fn() });
    assignWindowRole(
      { isDestroyed: () => false, once: vi.fn(), webContents: requester } as never,
      'visible-ui'
    );
    const unregister = registerEmbeddingHostIpcHandlers(run.manager, {
      stop: () => run.manager.stop(),
    });
    onTestFinished(() => {
      unregister();
      clearWindowRoleByWebContentsId(requester.id);
    });
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
      const handler = ipcHandlers.get(channel);
      if (!handler) {
        throw new Error('Missing visible query IPC');
      }
      return Promise.resolve(
        handler({ sender: requester, senderFrame: createAllowlistedSenderFrame() }, ...args)
      );
    };
    const bridge = getEmbeddingHostBridge();
    if (!bridge) {
      throw new Error('Missing hidden host fixture bridge');
    }
    Object.assign(bridge, {
      cancelQueryEmbedding: (requestId: string) =>
        invoke(DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding, requestId),
      queryEmbedding: (payload: unknown, options: { requestId: string }) =>
        invoke(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, { payload, ...options }),
    });
    const controller = new AbortController();
    const reason = new Error('Visible search superseded');
    const settled = vi.fn();
    const result = generateDesktopQueryEmbedding(query, { signal: controller.signal }).then(
      (value) => {
        settled(value);
        return value;
      },
      (error: unknown) => {
        settled(error);
        return error;
      }
    );
    await act(async () => {});
    expect(settled).not.toHaveBeenCalled();
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    controller.abort(reason);
    await act(async () => {});
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    expect(run.cancel).not.toHaveBeenCalled();
    run.finish();
    await expect(result).resolves.toBe(reason);
    expect(run.isPhysicallyActive()).toBe(false);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });

  it('keeps the public query cancellation pending while the actual queue is held', async () => {
    const run = await connectControlledQuery();
    const controller = new AbortController();
    const reason = { source: 'caller' };
    const settled = vi.fn();
    const result = run.manager
      .queryEmbedding(query, { signal: controller.signal })
      .catch((error: unknown) => {
        settled();
        return error;
      });
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    controller.abort(reason);
    await act(async () => {});
    expect(settled).not.toHaveBeenCalled();
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalled();
    run.finish();
    await expect(result).resolves.toBe(reason);
    expect(run.isPhysicallyActive()).toBe(false);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });

  it('joins an independent queue AbortError without replacing it with the caller reason', async () => {
    const run = await connectControlledQuery();
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const result = run.manager
      .queryEmbedding(query, { signal: controller.signal })
      .catch((error: unknown) => error);
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    controller.abort(reason);
    await act(async () => {});
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    run.fail(new DOMException('independent queue abort', 'AbortError'));
    const causes = failureCauses(await result);
    expect(causes).toEqual([
      reason,
      expect.objectContaining({ message: 'independent queue abort', name: 'AbortError' }),
    ]);
    expect(run.isPhysicallyActive()).toBe(false);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });

  it('signals only the canceled active request while retaining its physical queue ownership', async () => {
    const run = await connectControlledQuery();
    const controller = new AbortController();
    const result = run.manager.queryEmbedding(query, { signal: controller.signal }).then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    const request = assertEmbeddingHostQueryEmbeddingRequest(
      hostWindow.webContents.send.mock.calls.find(
        ([channel]) => channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT
      )?.[1]
    );
    const reason = new Error('Request canceled');
    controller.abort(reason);
    await act(async () => {});
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    const canceledSignal = run.add.mock.calls[0]?.[1]?.signal;
    const cancellationReason: unknown = canceledSignal?.reason;
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(request));
    expect(canceledSignal?.reason).toBe(cancellationReason);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(run.cancel).not.toHaveBeenCalled();
    const sibling = run.manager.queryEmbedding({
      ...query,
      modelId: 'model-b',
      modelKey: 'local:model-b',
    });
    await act(async () => {});
    expect(run.add).toHaveBeenCalledOnce();
    expect(run.dispose).not.toHaveBeenCalled();
    run.finish();
    await expect(result).resolves.toBe(reason);
    await expect(sibling).resolves.toHaveLength(2);
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
    expect(run.add.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  // Lifecycle redesign PR D (R5(a)): a query past its bound is refused alone, never a Stop.
  it('refuses a query past its bound at once when its cancel cannot be sent, and keeps the host', async () => {
    const run = await connectControlledQuery();
    const timeoutWarnings: (readonly unknown[])[] = [];
    onTestFinished(
      addLogListener((entry) => {
        if (
          entry.level === 'warn' &&
          entry.scope === 'EmbeddingHostManager' &&
          entry.message === 'Embedding host query timed out'
        ) {
          timeoutWarnings.push(entry.args);
        }
      })
    );
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const request = run.manager.queryEmbedding(query).catch((error: unknown) => error);
    await act(async () => {});
    expect(run.add).toHaveBeenCalledOnce();
    const send = hostWindow.webContents.send.getMockImplementation()!;
    const transportFailure = new Error('Transport write failed');
    hostWindow.webContents.send.mockImplementation((channel: string, payload: unknown) => {
      if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT) {
        throw transportFailure;
      }
      send(channel, payload);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    expect(timeoutWarnings).toEqual([
      [
        'Embedding host query timed out',
        {
          elapsedMs: 60_000,
          pendingCount: 1,
          provider: 'local',
          stage: 'host-response',
          timeoutMs: 60_000,
        },
      ],
    ]);
    const failure = await request;
    expect(failure).toBeInstanceOf(AggregateError);
    const causes = failureCauses(failure);
    expect(causes).toContainEqual(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'embedding-host.query-timeout' }),
      })
    );
    expect(causes).toContainEqual(
      expect.objectContaining({
        cause: transportFailure,
        message: 'Embedding host query cancellation could not be sent.',
      })
    );
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(hostWindow.isDestroyed()).toBe(false);
    expect(run.manager.getStatus().state).toBe('running');
    // The host still owns the inference it never heard was cancelled, and settles it itself.
    expect(run.isPhysicallyActive()).toBe(true);
    run.finish();
    await waitFor(() => expect(run.isPhysicallyActive()).toBe(false));
  });
  // ADR-0031: a cancel the host cannot be sent retires the host at once; nothing waits on it.
  it('retires the host at once after a failed abort cancellation send and preserves its causes', async () => {
    const run = await connectControlledQuery();
    const controller = new AbortController();
    const request = run.manager
      .queryEmbedding(query, { signal: controller.signal })
      .catch((error: unknown) => error);
    await act(async () => {});
    expect(run.add).toHaveBeenCalledOnce();
    const send = hostWindow.webContents.send.getMockImplementation()!;
    const transportFailure = new Error('Transport write failed');
    hostWindow.webContents.send.mockImplementation((channel: string, payload: unknown) => {
      if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT) {
        throw transportFailure;
      }
      send(channel, payload);
    });
    controller.abort(new Error('Ordinary cancellation reason'));
    const failure = await request;
    expect(hostWindow.isDestroyed()).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const causes = failureCauses(failure);
    expect(causes).toContainEqual(
      expect.objectContaining({
        cause: transportFailure,
        message: 'Embedding host query cancellation could not be sent.',
      })
    );
    expect(causes).toContainEqual(
      expect.objectContaining({ message: 'Ordinary cancellation reason' })
    );
    expect(run.add).toHaveBeenCalledOnce();
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(run.manager.getStatus().state).toBe('stopped');
  });

  it('rejects query admission when the present host bridge lacks request cancellation', async () => {
    const run = await connectControlledQuery({ cancellationCapability: false });
    await expect(run.manager.queryEmbedding(query)).rejects.toThrow(
      'Embedding host query cancellation capability is unavailable.'
    );
    expect(run.add).not.toHaveBeenCalled();
    expect(readModelCatalogMock).not.toHaveBeenCalled();
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('refuses a queued query past its bound alone: its preparation is skipped, the active one completes', async () => {
    const run = await connectControlledQuery();
    const active = run.manager.queryEmbedding(query).catch((error: unknown) => error);
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const queued = run.manager
      .queryEmbedding({ ...query, modelId: 'model-b', modelKey: 'local:model-b' })
      .catch((error: unknown) => error);
    await act(async () => {});
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    expect(await queued).toMatchObject({
      failure: { code: 'embedding-host.query-timeout', kind: 'refusal' },
    });
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    run.finish();
    await expect(active).resolves.toHaveLength(2);
    expect(run.add).toHaveBeenCalledOnce();
    expect(readModelCatalogMock).toHaveBeenCalledOnce();
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('joins queued request abort before releasing identity and skips its preparation', async () => {
    const run = await connectControlledQuery();
    const active = run.manager.queryEmbedding(query).catch((error: unknown) => error);
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const queued = run.manager
      .queryEmbedding(
        { ...query, modelId: 'model-b', modelKey: 'local:model-b' },
        { signal: controller.signal }
      )
      .catch((error: unknown) => error);
    await act(async () => {});
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
    controller.abort(new Error('Queued request canceled'));
    await act(async () => {});
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
    expect(run.add).toHaveBeenCalledOnce();
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    const sibling = run.manager.queryEmbedding({
      ...query,
      modelId: 'model-c',
      modelKey: 'local:model-c',
    });
    run.finish();
    expect(failureCauses(await queued)).toContainEqual(
      expect.objectContaining({ message: 'Queued request canceled' })
    );
    await expect(active).resolves.toHaveLength(2);
    await expect(sibling).resolves.toHaveLength(2);
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
    expect(run.add).toHaveBeenCalledTimes(2);
    expect(readModelCatalogMock).toHaveBeenCalledTimes(2);
    expect(run.add.mock.calls.map(([task]) => task.model)).toEqual(['model-a', 'model-c']);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it.each(['model-read', 'initialization'] as const)(
    'keeps canceled active %s preparation owned until it settles, then skips its inference',
    async (stage) => {
      const run = await connectControlledQuery();
      const held = Promise.withResolvers<void>();
      const originalInitialize = SimpleEmbeddingService.prototype.initializeWithModel;
      const initialize = vi.spyOn(SimpleEmbeddingService.prototype, 'initializeWithModel');
      if (stage === 'model-read') {
        const original = readModelCatalogMock.getMockImplementation()!;
        readModelCatalogMock.mockImplementationOnce(async (...args: unknown[]) => {
          await held.promise;
          return original(...args);
        });
      } else {
        const original = originalInitialize;
        initialize.mockImplementationOnce(async function (this: SimpleEmbeddingService, ...args) {
          await held.promise;
          return original.apply(this, args);
        });
      }
      const controller = new AbortController();
      const head = run.manager
        .queryEmbedding(query, { signal: controller.signal })
        .catch((error: unknown) => error);
      await waitFor(() =>
        expect(stage === 'model-read' ? readModelCatalogMock : initialize).toHaveBeenCalledOnce()
      );
      const sibling = run.manager.queryEmbedding({
        ...query,
        modelId: 'model-b',
        modelKey: 'local:model-b',
      });
      await act(async () => {});
      controller.abort(new Error('Preparation canceled'));
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
      expect(run.add).not.toHaveBeenCalled();
      expect(run.dispose).not.toHaveBeenCalled();
      expect(readModelCatalogMock).toHaveBeenCalledOnce();
      held.resolve();
      expect(await head).toMatchObject({ message: 'Preparation canceled' });
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      run.finish();
      await expect(sibling).resolves.toHaveLength(2);
      await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
      expect(run.add).toHaveBeenCalledOnce();
      expect(initialize).toHaveBeenCalledTimes(stage === 'model-read' ? 1 : 2);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );

  it('ignores unknown and stale-runtime cancel notices without canceling an active sibling', async () => {
    const run = await connectControlledQuery();
    const result = run.manager.queryEmbedding(query);
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    const sent = hostWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT
    );
    const request = assertEmbeddingHostQueryEmbeddingRequest(sent?.[1]);
    queryEmbeddingCancelListenerRef.current?.({
      ...createEmbeddingHostQueryEmbeddingCancel(request),
      requestId: 'unknown',
    });
    queryEmbeddingCancelListenerRef.current?.({
      ...createEmbeddingHostQueryEmbeddingCancel(request),
      runtimeId: 'old-runtime',
    });
    queryEmbeddingCancelListenerRef.current?.({
      ...createEmbeddingHostQueryEmbeddingCancel(request),
      payload: { requestId: request.requestId },
    });
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    run.finish();
    await expect(result).resolves.toHaveLength(2);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    run.view.unmount();
    expect(queryEmbeddingListenerRef.current).toBeNull();
    expect(queryEmbeddingCancelListenerRef.current).toBeNull();
  });

  it.each(['stop', 'reset'] as const)(
    'fences active and queued request identities on %s without leaking cancellation into a replacement',
    async (action) => {
      const run = await connectControlledQuery();
      const active = run.manager.queryEmbedding(query).catch((error: unknown) => error);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      const queued = run.manager
        .queryEmbedding({ ...query, modelId: 'model-b', modelKey: 'local:model-b' })
        .catch((error: unknown) => error);
      await act(async () => {});
      const requests = hostWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT)
        .map(([, payload]) => assertEmbeddingHostQueryEmbeddingRequest(payload));
      const transition = action === 'stop' ? run.manager.stop() : run.manager.reset();
      expect(await active).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      expect(hostWindow.destroy).toHaveBeenCalledOnce();
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
      if (action === 'reset') {
        await mountReplacementRenderer(run.view);
      }
      await expect(transition).resolves.toMatchObject({
        state: action === 'stop' ? 'stopped' : 'running',
      });
      expect(run.add).toHaveBeenCalledOnce();
      expect(readModelCatalogMock).toHaveBeenCalledOnce();
      if (action === 'reset') {
        const replacement = run.manager.queryEmbedding({
          ...query,
          modelId: 'model-c',
          modelKey: 'local:model-c',
        });
        await waitFor(() => expect(run.add).toHaveBeenCalledTimes(2));
        for (const request of requests) {
          queryEmbeddingCancelListenerRef.current?.(
            createEmbeddingHostQueryEmbeddingCancel(request)
          );
        }
        expect(run.add.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
        run.finish();
        await expect(replacement).resolves.toHaveLength(2);
      }
    }
  );

  // ADR-0031: Stop, quit and reset destroy the hidden window at once; no close budget waits on it.
  it.each(['stop', 'shutdown', 'reset'] as const)(
    'retires a non-cooperative host at once on %s',
    async (action) => {
      const run = await connectControlledQuery();
      const request = run.manager.queryEmbedding(query).catch((error: unknown) => error);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      const operation =
        action === 'stop'
          ? run.manager.stop()
          : action === 'reset'
            ? run.manager.reset()
            : run.manager.dispose();
      expect(await request).toBeInstanceOf(Error);
      expect(hostWindow.destroy).toHaveBeenCalledOnce();
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
      // The host never settled its inference; nothing waited for it to.
      expect(run.isPhysicallyActive()).toBe(true);
      if (action === 'reset') {
        await mountReplacementRenderer(run.view);
      }
      await operation;
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(action === 'reset' ? 2 : 1);
    }
  );
});
