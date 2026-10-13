import './embedding-host-runtime-fixture';
import { recordEmbeddingTelemetryFailure } from '@brainstrike/embedding-worker';
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
  currentDbRef,
  dbHandle,
  disposeQueryEmbeddingServiceMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  hostWindow,
  initializeWithModelMock,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  readModelCatalogMock,
  reopenEmbeddingQueueMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
  storeState,
} from './embedding-host-runtime-fixture';

const QUERY = {
  dimensions: 2,
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local:Xenova/all-MiniLM-L6-v2',
  query: 'fixture query',
};

function createConnectedManager(): EmbeddingHostManager {
  storeState.hasHydrated = true;
  readModelCatalogMock.mockResolvedValue({
    models: [
      {
        capabilities: { defaultDimension: 2 },
        description: '',
        id: QUERY.modelId,
        name: 'Fixture model',
        parameters: {},
        providerId: 'local',
      },
    ],
  });
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
  onTestFinished(async () => {
    vi.useRealTimers();
    hostWindow.destroy();
    await manager.dispose();
    configureDesktopRendererTarget(null);
  });
  return manager;
}

describe('embedding host native catalog and runtime readiness', () => {
  installEmbeddingHostRuntimeFixture();

  it('keeps native readiness and inference independent of a disappearing PGlite handle', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const runtimeId = manager.getStatus().runtimeId;
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    expect(manager.getStatus()).toMatchObject({ runtimeId, state: 'running' });
    expect(dbHandle.query).not.toHaveBeenCalled();
    expect(readModelCatalogMock).toHaveBeenCalledOnce();
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
  });

  it('waits for native queue readiness before dispatching a query', async () => {
    const manager = createConnectedManager();
    const opened = Promise.withResolvers<void>();
    reopenEmbeddingQueueMock.mockReturnValueOnce(opened.promise);
    onTestFinished(() => opened.resolve());
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce());
    hostWindow.webContents.send.mockClear();
    const query = manager.queryEmbedding(QUERY);
    await act(async () => {});
    expect(hostWindow.webContents.send).not.toHaveBeenCalled();
    expect(generateQueryEmbeddingMock).not.toHaveBeenCalled();
    opened.resolve();
    await expect(query).resolves.toEqual([0.1, 0.2]);
  });

  it('rejects an old catalog model read without initializing it after replacement', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const model = Promise.withResolvers<{ models: Record<string, unknown>[] }>();
    readModelCatalogMock.mockImplementationOnce(() => model.promise);
    const controller = new AbortController();
    const oldQuery = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const oldResult = oldQuery.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      await oldResult;
    });
    await waitFor(() => expect(readModelCatalogMock).toHaveBeenCalledTimes(1));
    const replacing = manager.reset();
    await act(async () => {});
    await replacing;
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    model.resolve({
      models: [
        {
          capabilities: { defaultDimension: 2 },
          id: QUERY.modelId,
          name: 'Old model',
          parameters: {},
          providerId: 'local',
        },
      ],
    });
    expect(await oldResult).toMatchObject({
      message: expect.stringContaining(
        'Embedding host reset while inference requests were in flight.'
      ),
    });
    expect(initializeWithModelMock).toHaveBeenCalledTimes(1);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
  });

  it('rejects old device preference hydration before constructing a service', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const hydrated = Promise.withResolvers<typeof storeState>();
    ensureVectorPreferencesHydratedMock.mockImplementationOnce(() => hydrated.promise);
    const controller = new AbortController();
    const oldQuery = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const oldResult = oldQuery.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      hydrated.resolve(storeState);
      await oldResult;
    });
    await waitFor(() => expect(readModelCatalogMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const replacing = manager.reset();
    await act(async () => {});
    await replacing;
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    hydrated.resolve(storeState);
    expect(await oldResult).toMatchObject({
      message: expect.stringContaining(
        'Embedding host reset while inference requests were in flight.'
      ),
    });
    expect(initializeWithModelMock).toHaveBeenCalledTimes(1);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
  });

  it.each(['disposed', 'failed'] as const)(
    'disposes a model initialized after its native owner was replaced (%s)',
    async (disposal) => {
      const manager = createConnectedManager();
      await manager.ensureStarted({ waitForRunning: false });
      const view = render(<EmbeddingHostRuntime />);
      onTestFinished(() => view.unmount());
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      const initialized = Promise.withResolvers<void>();
      initializeWithModelMock.mockImplementationOnce(() => initialized.promise);
      const controller = new AbortController();
      const oldQuery = manager.queryEmbedding(QUERY, { signal: controller.signal });
      const oldResult = oldQuery.then(
        () => null,
        (error: unknown) => error
      );
      onTestFinished(async () => {
        controller.abort();
        await oldResult;
      });
      await waitFor(() => expect(initializeWithModelMock).toHaveBeenCalledTimes(1));
      const oldService = initializeWithModelMock.mock.contexts[0];
      const replacing = manager.reset();
      await act(async () => {});
      await replacing;
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
      const currentService = initializeWithModelMock.mock.contexts[1];
      if (disposal === 'failed') {
        disposeQueryEmbeddingServiceMock.mockRejectedValueOnce(
          new Error('Fixture disposal failed.')
        );
      }
      initialized.resolve();
      expect(await oldResult).toMatchObject({
        message: expect.stringContaining(
          'Embedding host reset while inference requests were in flight.'
        ),
      });
      await waitFor(() =>
        expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              message:
                disposal === 'failed'
                  ? 'Fixture disposal failed.'
                  : 'Embedding host query runtime is no longer available.',
            }),
            type: 'error',
          })
        )
      );
      expect(disposeQueryEmbeddingServiceMock.mock.contexts).toContain(oldService);
      expect(disposeQueryEmbeddingServiceMock.mock.contexts).not.toContain(currentService);
      expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps replacement query activity and service intact when old inference completes', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    type Generated = Awaited<ReturnType<typeof generateQueryEmbeddingMock>>;
    const oldInference = Promise.withResolvers<Generated>();
    const newInference = Promise.withResolvers<Generated>();
    generateQueryEmbeddingMock
      .mockImplementationOnce(() => oldInference.promise)
      .mockImplementationOnce(() => newInference.promise);
    const controller = new AbortController();
    const oldQuery = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const oldResult = oldQuery.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      await oldResult;
    });
    await waitFor(() => expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1));
    const replacing = manager.reset();
    await act(async () => {});
    await act(async () => {});
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
    const generated: Generated = {
      embedding: [0.1, 0.2],
      runtime: { device: 'webgpu', dtype: 'fp32', fallbackApplied: false },
    };
    oldInference.resolve(generated);
    expect(await oldResult).toMatchObject({
      message: 'Embedding host query runtime is no longer available.',
    });
    await replacing;
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const newQuery = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const newResult = newQuery.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      await newResult;
    });
    await waitFor(() => expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(2));

    expect(manager.getStatus().active).toBe(true);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    newInference.resolve(generated);
    await expect(newQuery).resolves.toEqual([0.1, 0.2]);
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false, state: 'running' })
    );
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    expect(initializeWithModelMock).toHaveBeenCalledTimes(2);
  });

  it('keeps new query activity after same-catalog reset when old inference finishes', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    // Establish real runtime metadata so the public telemetry publisher reads activity.
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    type Generated = Awaited<ReturnType<typeof generateQueryEmbeddingMock>>;
    const generated: Generated = {
      embedding: [0.1, 0.2],
      runtime: { device: 'webgpu', dtype: 'fp32', fallbackApplied: false },
    };
    const oldInference = Promise.withResolvers<Generated>();
    const newInference = Promise.withResolvers<Generated>();
    generateQueryEmbeddingMock
      .mockImplementationOnce(() => oldInference.promise)
      .mockImplementationOnce(() => newInference.promise);
    const oldController = new AbortController();
    const newController = new AbortController();
    const oldRuntimeId = manager.getStatus().runtimeId;
    const oldQuery = manager.queryEmbedding(QUERY, { signal: oldController.signal });
    const oldResult = oldQuery.catch((error: unknown) => error);
    onTestFinished(async () => {
      oldController.abort();
      newController.abort();
      oldInference.resolve(generated);
      newInference.resolve(generated);
      await oldResult;
    });
    await waitFor(() => expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(2));
    const resetting = manager.reset();
    await act(async () => {});
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().state).toBe('starting');
    oldInference.resolve(generated);
    await expect(resetting).resolves.toMatchObject({ state: 'running' });
    expect(currentDbRef.current).toBe(dbHandle);
    expect(manager.getStatus().runtimeId).not.toBe(oldRuntimeId);
    expect(await oldResult).toMatchObject({
      message: 'Embedding host query runtime is no longer available.',
    });
    const newQuery = manager.queryEmbedding(QUERY, { signal: newController.signal });
    const newResult = newQuery.catch((error: unknown) => error);
    onTestFinished(async () => {
      newController.abort();
      await newResult;
    });
    await waitFor(() => expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeId: oldRuntimeId, type: 'error' })
      )
    );
    vi.useFakeTimers();
    await act(async () => {
      recordEmbeddingTelemetryFailure('fixture telemetry publication');
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true, state: 'running' })
    );
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    vi.useRealTimers();
    newInference.resolve(generated);
    await expect(newQuery).resolves.toEqual([0.1, 0.2]);
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false, state: 'running' })
    );
  });

  it('keeps selected Stop authoritative when held query inference completes', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    type Generated = Awaited<ReturnType<typeof generateQueryEmbeddingMock>>;
    const inference = Promise.withResolvers<Generated>();
    generateQueryEmbeddingMock.mockImplementationOnce(() => inference.promise);
    const controller = new AbortController();
    const query = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const result = query.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      await result;
    });
    await waitFor(() => expect(generateQueryEmbeddingMock).toHaveBeenCalledOnce());
    const stopping = manager.stop();
    await act(async () => {});
    expect(manager.getStatus().state).toBe('stopping');
    expect(disposeQueryEmbeddingServiceMock).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    reportStatusMock.mockClear();
    inference.resolve({
      embedding: [0.1, 0.2],
      runtime: { device: 'webgpu', dtype: 'fp32', fallbackApplied: false },
    });
    await expect(stopping).resolves.toMatchObject({ state: 'stopped' });
    expect(await result).toBeInstanceOf(Error);
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalled());
    expect(manager.getStatus().state).toBe('stopped');
    expect(reportStatusMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'running' })
    );
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });

  it('joins old stop and service disposal before starting the replacement owner', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    const oldService = initializeWithModelMock.mock.contexts[0];
    const stopped = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    retireEmbeddingQueueMock.mockImplementationOnce(() => stopped.promise);
    disposeQueryEmbeddingServiceMock.mockImplementationOnce(() => disposed.promise);
    const replacing = manager.reset();
    await waitFor(() => expect(retireEmbeddingQueueMock).toHaveBeenCalledOnce());
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    stopped.resolve();
    await waitFor(() => expect(disposeQueryEmbeddingServiceMock).toHaveBeenCalledTimes(1));
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).toEqual([oldService]);
    disposed.resolve();
    await replacing;
    await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    expect(initializeWithModelMock).toHaveBeenCalledTimes(2);
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).toEqual([oldService]);
  });

  it('delivers a query after immediate component replacement with a ready catalog', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime key="before" />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime key="after" />);
    });
    expect(queryEmbeddingListenerRef.current).toBeTypeOf('function');
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
  });
});
