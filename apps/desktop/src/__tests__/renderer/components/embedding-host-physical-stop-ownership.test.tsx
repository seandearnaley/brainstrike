import './embedding-host-foreground-ownership-fixture';
import {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import {
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  dbHandle,
  hostWindow,
  installEmbeddingHostRuntimeFixture,
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

async function connectControlledQuery() {
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
    commandListenerRef.current?.(payload);
  });
  await manager.ensureStarted({ waitForRunning: false });
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

  it('releases a canceled main request without canceling the real renderer queue execution', async () => {
    const run = await connectControlledQuery();
    const controller = new AbortController();
    const result = run.manager.queryEmbedding(query, { signal: controller.signal }).then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(run.add).toHaveBeenCalledOnce());
    controller.abort(new Error('Request canceled'));
    expect(await result).toMatchObject({ message: 'Request canceled' });
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(run.isPhysicallyActive()).toBe(true);
    expect(run.add.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(run.cancel).not.toHaveBeenCalled();
    run.finish();
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledOnce());
    expect(run.manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
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
