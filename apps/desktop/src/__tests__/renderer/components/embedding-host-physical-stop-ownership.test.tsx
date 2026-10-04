import './embedding-host-foreground-ownership-fixture';
import { EventEmitter } from 'node:events';
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
import { registerEmbeddingHostIpcHandlers } from '../../../ipc-embedding-host';
import { DESKTOP_IPC_CHANNELS } from '../../../platform/desktop-ipc-channels';
import { getEmbeddingHostBridge } from '../../../renderer/components/embedding-host-bridge';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import { generateDesktopQueryEmbedding } from '../../../renderer/query-embeddings';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../../window-role';
import { createAllowlistedSenderFrame } from '../../helpers/desktop-ipc-sender-frame-test-allowlist';
import {
  commandListenerRef,
  dbHandle,
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  ipcHandlers,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
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
    fail: (error: unknown) => held.reject(error),
    finish,
    isPhysicallyActive: () => physicallyActive,
    manager,
    view,
  };
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
    const unregister = registerEmbeddingHostIpcHandlers(run.manager);
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
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(run.cancel).not.toHaveBeenCalled();
    reportStatusMock.mockClear();
    run.finish();
    await expect(stopping).resolves.toMatchObject({ state: 'stopped' });
    expect(await oldQuery).toBeInstanceOf(Error);
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
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(run.cancel).not.toHaveBeenCalled();
    run.finish();
    await expect(resetting).resolves.toMatchObject({ state: 'running' });
    expect(await oldQuery).toBeInstanceOf(Error);
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
  it.each(['abort', 'timeout'] as const)(
    'joins shared Stop after a failed %s cancellation send and preserves its causes',
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
      await act(async () => {});
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
      expect(run.isPhysicallyActive()).toBe(true);
      expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
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
      expect(hostWindow.isDestroyed()).toBe(false);
      run.finish();
      const failure = await request;
      expect(failure).toBeInstanceOf(AggregateError);
      const causes = failureCauses(failure);
      expect(causes).toContainEqual(
        expect.objectContaining({
          cause: transportFailure,
          message: 'Embedding host query cancellation could not be sent.',
        })
      );
      expect(causes).toContainEqual(
        expect.objectContaining({
          message:
            reason === 'abort'
              ? 'Ordinary cancellation reason'
              : expect.stringContaining('timed out after 60000ms'),
        })
      );
      expect(run.isPhysicallyActive()).toBe(false);
      expect(run.add).toHaveBeenCalledOnce();
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
    'joins queued request %s before releasing identity and skips its preparation',
    async (reason) => {
      const run = await connectControlledQuery();
      const active = run.manager.queryEmbedding(query).catch((error: unknown) => error);
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
      await act(async () => {});
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
      expect(run.add).toHaveBeenCalledOnce();
      expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(reason === 'timeout');
      const sibling =
        reason === 'abort'
          ? run.manager.queryEmbedding({
              ...query,
              modelId: 'model-c',
              modelKey: 'local:model-c',
            })
          : null;
      run.finish();
      expect(failureCauses(await queued)).toContainEqual(
        expect.objectContaining({
          message:
            reason === 'abort'
              ? 'Queued request canceled'
              : expect.stringContaining('timed out after 60000ms'),
        })
      );
      if (sibling) {
        await expect(active).resolves.toHaveLength(2);
        await expect(sibling).resolves.toHaveLength(2);
        await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
        expect(run.add).toHaveBeenCalledTimes(2);
        expect(dbHandle.query.mock.calls.map(([, values]) => values)).toEqual([
          ['model-a'],
          ['model-c'],
        ]);
      } else {
        expect(await active).toBeInstanceOf(Error);
        expect(run.add).toHaveBeenCalledOnce();
        expect(dbHandle.query.mock.calls.map(([, values]) => values)).toEqual([['model-a']]);
      }
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
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
      expect(run.add).not.toHaveBeenCalled();
      expect(run.dispose).not.toHaveBeenCalled();
      expect(dbHandle.query).toHaveBeenCalledOnce();
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
      const cancelListener = queryEmbeddingCancelListenerRef.current;
      const transition = action === 'stop' ? run.manager.stop() : run.manager.reset();
      await act(async () => {});
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(2);
      for (const request of requests) {
        cancelListener?.(createEmbeddingHostQueryEmbeddingCancel(request));
      }
      expect(run.add).toHaveBeenCalledOnce();
      run.finish();
      await expect(transition).resolves.toMatchObject({
        state: action === 'stop' ? 'stopped' : 'running',
      });
      expect(await active).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
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
      await act(async () => {});
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(1);
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
      expect(await request).toBeInstanceOf(Error);
      expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
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
