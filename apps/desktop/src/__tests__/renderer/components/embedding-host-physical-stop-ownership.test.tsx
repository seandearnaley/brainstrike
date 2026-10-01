import './embedding-host-foreground-ownership-fixture';
import {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { addLogListener } from '@brainstrike/logging';
import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { act, render, waitFor } from '@testing-library/react';
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
import { getEmbeddingHostBridge } from '../../../renderer/components/embedding-host-bridge';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  dbHandle,
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} from './embedding-host-foreground-ownership-fixture';

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
  dbHandle.query.mockResolvedValue({
    rows: [
      {
        capabilities: { defaultDimension: 2 },
        description: '',
        id: 'model-a',
        name: 'Fixture',
        parameters: {},
        providerId: 'local',
      },
    ],
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
    finish,
    isPhysicallyActive: () => physicallyActive,
    manager,
    view,
  };
}

describe('committed readiness fix physical query ownership controls', () => {
  installEmbeddingHostRuntimeFixture();

  it('joins actual query queue settlement before manual host Stop disposes its service', async () => {
    const run = await connectControlledQuery();
    const oldQuery = run.manager.queryEmbedding(query).then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    expect(run.isPhysicallyActive()).toBe(true);
    const stopping = run.manager.stop();
    await act(async () => {});
    expect(run.manager.getStatus().state).toBe('stopping');
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await oldQuery).toMatchObject({
      message: expect.stringContaining(
        'Embedding host stopped while query embedding requests were in flight.'
      ),
    });
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(run.cancel).not.toHaveBeenCalled();
    reportStatusMock.mockClear();
    run.finish();
    await expect(stopping).resolves.toMatchObject({ state: 'stopped' });
    expect(run.dispose).toHaveBeenCalledOnce();
    await waitFor(() => expect(run.isPhysicallyActive()).toBe(false));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledOnce());
    expect(run.manager.getStatus().state).toBe('stopped');
    expect(reportStatusMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'running' })
    );
  });

  it('joins actual query queue settlement before reset starts its replacement worker', async () => {
    const run = await connectControlledQuery();
    const oldQuery = run.manager.queryEmbedding(query).then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    expect(run.isPhysicallyActive()).toBe(true);
    const resetting = run.manager.reset();
    await act(async () => {});
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(run.manager.getStatus().state).toBe('starting');
    expect(await oldQuery).toMatchObject({
      message: expect.stringContaining(
        'Embedding host reset while query embedding requests were in flight.'
      ),
    });
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(run.cancel).not.toHaveBeenCalled();
    run.finish();
    await expect(resetting).resolves.toMatchObject({ state: 'running' });
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2);
    expect(run.dispose).toHaveBeenCalledOnce();
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledOnce());
    expect(run.manager.getStatus().state).toBe('running');
  });

  it.each([
    ['stop', 'success'],
    ['stop', 'failure'],
    ['reset', 'success'],
    ['reset', 'failure'],
  ] as const)(
    'joins pending cached-service disposal on %s %s through the real manager',
    async (action, outcome) => {
      const run = await connectControlledQuery();
      const warm = run.manager.queryEmbedding(query);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      run.finish();
      await warm;
      const held = Promise.withResolvers<void>();
      run.dispose.mockImplementationOnce(() => held.promise);
      const switching = run.manager
        .queryEmbedding({ ...query, modelId: 'model-b', modelKey: 'local:model-b' })
        .catch((error: unknown) => error);
      await waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
      let settled = false;
      const backgroundStop = Promise.withResolvers<void>();
      if (action === 'stop' && outcome === 'failure') {
        // Disposal may reject while background Stop is still pending: attach both immediately.
        stopMock.mockReturnValueOnce(backgroundStop.promise);
        onTestFinished(() => backgroundStop.resolve());
      }
      const command = action === 'stop' ? run.manager.stop() : run.manager.reset();
      const result = command.then(
        (status) => {
          settled = true;
          return status;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await act(async () => {});
      expect(settled).toBe(false);
      expect(hostWindow.destroy).not.toHaveBeenCalled();
      expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
      expect(run.dispose).toHaveBeenCalledOnce();
      if (outcome === 'failure') {
        held.reject(new Error('Owned service disposal failed.'));
      } else {
        held.resolve();
      }
      const completion = await result;
      backgroundStop.resolve();
      await switching;
      expect(run.dispose).toHaveBeenCalledOnce();
      if (outcome === 'failure') {
        expect(completion).toMatchObject(
          action === 'stop'
            ? { message: 'Owned service disposal failed.' }
            : { lastError: 'Owned service disposal failed.', state: 'error' }
        );
        expect(hostWindow.destroy).toHaveBeenCalledOnce();
        expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
        expect(run.add).toHaveBeenCalledOnce();
      } else {
        expect(completion).toMatchObject({ state: action === 'stop' ? 'stopped' : 'running' });
        expect(hostWindow.destroy).not.toHaveBeenCalled();
        expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(action === 'stop' ? 1 : 2);
        if (action === 'reset') {
          await expect(run.manager.queryEmbedding(query)).resolves.toHaveLength(2);
          expect(run.add).toHaveBeenCalledTimes(2);
        }
      }
    }
  );

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
    expect(await result).toBe(reason);
    const canceledSignal = run.add.mock.calls[0]?.[1]?.signal;
    const cancellationReason: unknown = canceledSignal?.reason;
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(request));
    expect(canceledSignal?.reason).toBe(cancellationReason);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
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
    await expect(sibling).resolves.toHaveLength(2);
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
    expect(run.add.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it.each(['abort', 'timeout'] as const)(
    'surfaces a failed %s cancellation send while preserving valid sibling ownership',
    async (reason) => {
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
      const controller = new AbortController();
      if (reason === 'timeout') {
        vi.useFakeTimers();
        onTestFinished(() => {
          vi.useRealTimers();
        });
      }
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
      if (reason === 'abort') {
        controller.abort(new Error('Ordinary cancellation reason'));
      } else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        vi.useRealTimers();
      }
      expect(await request).toMatchObject({
        cause: transportFailure,
        message: 'Embedding host query cancellation could not be sent.',
      });
      if (reason === 'timeout') {
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
      }
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
      expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      const sibling = run.manager.queryEmbedding({
        ...query,
        modelId: 'model-b',
        modelKey: 'local:model-b',
      });
      await act(async () => {});
      expect(run.add).toHaveBeenCalledOnce();
      expect(hostWindow.isDestroyed()).toBe(false);
      run.finish();
      await expect(sibling).resolves.toHaveLength(2);
      expect(run.add.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );

  it('rejects query admission when the present host bridge lacks request cancellation', async () => {
    const run = await connectControlledQuery({ cancellationCapability: false });
    await expect(run.manager.queryEmbedding(query)).rejects.toThrow(
      'Embedding host query cancellation capability is unavailable.'
    );
    expect(run.add).not.toHaveBeenCalled();
    expect(dbHandle.query).not.toHaveBeenCalled();
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it.each(['abort', 'timeout'] as const)(
    'skips all preparation for a queued request abandoned by %s and still runs its sibling',
    async (reason) => {
      const run = await connectControlledQuery();
      const active = run.manager.queryEmbedding(query);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      const controller = new AbortController();
      if (reason === 'timeout') {
        vi.useFakeTimers();
        onTestFinished(() => {
          vi.useRealTimers();
        });
      }
      const queued = run.manager
        .queryEmbedding(
          { ...query, modelId: 'model-b', modelKey: 'local:model-b' },
          { signal: controller.signal }
        )
        .catch((error: unknown) => error);
      await act(async () => {});
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
      if (reason === 'abort') {
        controller.abort(new Error('Queued request canceled'));
      } else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        vi.useRealTimers();
      }
      expect(await queued).toMatchObject({
        message:
          reason === 'abort'
            ? 'Queued request canceled'
            : expect.stringContaining('timed out after 60000ms'),
      });
      const sibling = run.manager.queryEmbedding({
        ...query,
        modelId: 'model-c',
        modelKey: 'local:model-c',
      });
      await act(async () => {});
      expect(run.add).toHaveBeenCalledOnce();
      expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      run.finish();
      await expect(active).resolves.toHaveLength(2);
      await expect(sibling).resolves.toHaveLength(2);
      await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
      expect(run.add).toHaveBeenCalledTimes(2);
      expect(dbHandle.query.mock.calls.map(([, values]) => values)).toEqual([
        ['model-a'],
        ['model-c'],
      ]);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    }
  );
  it.each(['model-read', 'initialization'] as const)(
    'keeps canceled active %s preparation owned until it settles, then skips its inference',
    async (stage) => {
      const run = await connectControlledQuery();
      const held = Promise.withResolvers<void>();
      const originalInitialize = SimpleEmbeddingService.prototype.initializeWithModel;
      const initialize = vi.spyOn(SimpleEmbeddingService.prototype, 'initializeWithModel');
      if (stage === 'model-read') {
        const original = dbHandle.query.getMockImplementation()!;
        dbHandle.query.mockImplementationOnce(async (...args: unknown[]) => {
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
        expect(stage === 'model-read' ? dbHandle.query : initialize).toHaveBeenCalledOnce()
      );
      const sibling = run.manager.queryEmbedding({
        ...query,
        modelId: 'model-b',
        modelKey: 'local:model-b',
      });
      await act(async () => {});
      controller.abort(new Error('Preparation canceled'));
      expect(await head).toMatchObject({ message: 'Preparation canceled' });
      expect(run.add).not.toHaveBeenCalled();
      expect(run.dispose).not.toHaveBeenCalled();
      expect(dbHandle.query).toHaveBeenCalledOnce();
      held.resolve();
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
      const cancelListener = queryEmbeddingCancelListenerRef.current;
      const transition = action === 'stop' ? run.manager.stop() : run.manager.reset();
      expect(await active).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
      for (const request of requests) {
        cancelListener?.(createEmbeddingHostQueryEmbeddingCancel(request));
      }
      expect(run.add).toHaveBeenCalledOnce();
      run.finish();
      await expect(transition).resolves.toMatchObject({
        state: action === 'stop' ? 'stopped' : 'running',
      });
      await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
      expect(dbHandle.query).toHaveBeenCalledOnce();
      if (action === 'reset') {
        const replacement = run.manager.queryEmbedding({
          ...query,
          modelId: 'model-c',
          modelKey: 'local:model-c',
        });
        await act(async () => {});
        for (const request of requests) {
          cancelListener?.(createEmbeddingHostQueryEmbeddingCancel(request));
        }
        await expect(replacement).resolves.toHaveLength(2);
        expect(run.add).toHaveBeenCalledTimes(2);
        expect(run.add.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
      }
      run.view.unmount();
      expect(queryEmbeddingListenerRef.current).toBeNull();
      expect(queryEmbeddingCancelListenerRef.current).toBeNull();
    }
  );

  it.each(['recoverable', 'limit'] as const)(
    'joins active query ownership on the %s fatal path',
    async (path) => {
      const run = await connectControlledQuery();
      const trigger = (index: number): void => {
        const options = startEmbeddingWorkerMock.mock.calls[index]?.[0] as
          | { onFatalError?: (error: Error) => void }
          | undefined;
        if (!options?.onFatalError) {
          throw new Error('Expected public worker fatal callback.');
        }
        options.onFatalError(new Error('WebGPU device lost: device was lost'));
      };
      if (path === 'limit') {
        trigger(0);
        await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2));
        trigger(1);
        await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(3));
      }
      const starts = path === 'limit' ? 3 : 1;
      const result = run.manager.queryEmbedding(query).then(
        () => null,
        (error: unknown) => error
      );
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      trigger(starts - 1);
      await act(async () => {});
      expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(run.isPhysicallyActive()).toBe(true);
      expect(run.dispose).not.toHaveBeenCalled();
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(starts);
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({ active: true, state: 'error' })
      );
      run.finish();
      await result;
      await waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
      if (path === 'recoverable') {
        await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2));
        expect(run.manager.getStatus().state).toBe('running');
      } else {
        await waitFor(() =>
          expect(reportStatusMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
              active: false,
              lastError: expect.stringContaining('repeated WebGPU device loss'),
              state: 'error',
            })
          )
        );
        expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(3);
      }
    }
  );

  it.each(['recoverable', 'limit'] as const)(
    'reports pending disposal failure on the %s fatal path without retrying or replacing',
    async (path) => {
      const run = await connectControlledQuery();
      const trigger = (index: number): void => {
        const options = startEmbeddingWorkerMock.mock.calls[index]?.[0] as {
          onFatalError: (error: Error) => void;
        };
        options.onFatalError(new Error('WebGPU device lost: device was lost'));
      };
      if (path === 'limit') {
        trigger(0);
        await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2));
        trigger(1);
        await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(3));
      }
      const starts = path === 'limit' ? 3 : 1;
      const warm = run.manager.queryEmbedding(query);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      run.finish();
      await warm;
      const held = Promise.withResolvers<void>();
      run.dispose.mockImplementationOnce(() => held.promise);
      const switching = run.manager
        .queryEmbedding({ ...query, modelId: 'model-b', modelKey: 'local:model-b' })
        .catch((error: unknown) => error);
      await waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
      try {
        trigger(starts - 1);
        await act(async () => {});
        expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(starts);
        expect(run.dispose).toHaveBeenCalledOnce();
      } finally {
        held.reject(new Error('Fatal cached-service disposal failed.'));
      }
      await switching;
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            lastError: expect.stringContaining('Fatal cached-service disposal failed.'),
            state: 'error',
          })
        )
      );
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(starts);
      expect(run.dispose).toHaveBeenCalledOnce();
      expect(run.add).toHaveBeenCalledOnce();
    }
  );

  it('keeps failed fatal restart closed while old physical inference remains active', async () => {
    const run = await connectControlledQuery();
    const result = run.manager.queryEmbedding(query).catch((error: unknown) => error);
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    stopMock.mockRejectedValueOnce(new Error('Worker drain failed'));
    const options = startEmbeddingWorkerMock.mock.calls[0]?.[0] as {
      onFatalError: (error: Error) => void;
    };
    options.onFatalError(new Error('WebGPU device lost: device was lost'));
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ active: true, lastError: 'Worker drain failed', state: 'error' })
      )
    );
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
    run.finish();
    await result;
    await act(async () => {});
    expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['stop', 10_000],
    ['shutdown', 3000],
    ['reset', 30_000],
  ] as const)(
    'retires a non-cooperative host at the unchanged %s deadline',
    async (action, deadline) => {
      const run = await connectControlledQuery();
      const request = run.manager.queryEmbedding(query).catch((error: unknown) => error);
      await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      let settled = false;
      const operation = (
        action === 'stop'
          ? run.manager.stop()
          : action === 'reset'
            ? run.manager.reset()
            : run.manager.dispose()
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await request;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(deadline - 1);
      });
      expect(settled).toBe(false);
      expect(hostWindow.isDestroyed()).toBe(false);
      expect(run.isPhysicallyActive()).toBe(true);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await operation;
      expect(settled).toBe(true);
      expect(hostWindow.isDestroyed()).toBe(true);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
      // Public document teardown fences callbacks; this fixture does not pretend to run native workers.
      run.view.unmount();
      run.finish();
      await act(async () => {});
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    }
  );
});
