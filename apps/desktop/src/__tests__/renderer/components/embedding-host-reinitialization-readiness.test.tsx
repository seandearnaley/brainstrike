import './embedding-host-runtime-fixture';
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
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
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
  dbHandle.query.mockResolvedValue({
    rows: [
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

describe('embedding host public database initialization readiness', () => {
  installEmbeddingHostRuntimeFixture();

  it('fails promptly when cached main status races database readiness reporting', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const statuses: unknown[] = [];
    reportStatusMock.mockImplementation((status: unknown) => statuses.push(status));
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    expect(manager.getStatus().state).toBe('running');
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
    await act(async () => {});
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(await result).toMatchObject({ message: 'Embedding host query runtime is unavailable.' });
    expect(generateQueryEmbeddingMock).not.toHaveBeenCalled();
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'starting' }));
    for (const status of statuses) {
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status));
    }
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
  });

  it('waits for listener readiness when the renderer honestly reports initializing', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    reportStatusMock({ ...manager.getStatus(), active: false, state: 'starting' });
    hostWindow.webContents.send.mockClear();
    const controller = new AbortController();
    const query = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const settled = query.then(
      () => null,
      (error: unknown) => error
    );
    onTestFinished(async () => {
      controller.abort();
      await settled;
    });
    await act(async () => {});
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
    expect(hostWindow.webContents.send).not.toHaveBeenCalled();
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    await expect(query).resolves.toEqual([0.1, 0.2]);
  });

  it('rejects an old database model read without initializing it after replacement', async () => {
    const manager = createConnectedManager();
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const model = Promise.withResolvers<{ rows: Record<string, unknown>[] }>();
    dbHandle.query.mockImplementationOnce(() => model.promise);
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
    await waitFor(() => expect(dbHandle.query).toHaveBeenCalledTimes(1));
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    model.resolve({
      rows: [
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
      message: 'Embedding host query runtime is no longer available.',
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
    await waitFor(() => expect(dbHandle.query).toHaveBeenCalledTimes(1));
    await act(async () => {});
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    hydrated.resolve(storeState);
    expect(await oldResult).toMatchObject({
      message: 'Embedding host query runtime is no longer available.',
    });
    expect(initializeWithModelMock).toHaveBeenCalledTimes(1);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
  });

  it('disposes a model initialized after its database owner was replaced', async () => {
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
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    const currentService = initializeWithModelMock.mock.contexts[1];
    initialized.resolve();
    expect(await oldResult).toMatchObject({
      message: 'Embedding host query runtime is no longer available.',
    });
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).toContain(oldService);
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).not.toContain(currentService);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
  });

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
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
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
    const generated: Generated = {
      embedding: [0.1, 0.2],
      runtime: { device: 'webgpu', dtype: 'fp32', fallbackApplied: false },
    };
    oldInference.resolve(generated);
    expect(await oldResult).toMatchObject({
      message: 'Embedding host query runtime is no longer available.',
    });
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
    await expect(manager.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(await result).toMatchObject({
      message: expect.stringContaining(
        'Embedding host stopped while query embedding requests were in flight.'
      ),
    });
    reportStatusMock.mockClear();
    inference.resolve({
      embedding: [0.1, 0.2],
      runtime: { device: 'webgpu', dtype: 'fp32', fallbackApplied: false },
    });
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
    stopMock.mockImplementationOnce(() => stopped.promise);
    disposeQueryEmbeddingServiceMock.mockImplementationOnce(() => disposed.promise);
    currentDbRef.current = null;
    view.rerender(<EmbeddingHostRuntime />);
    await waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1));
    currentDbRef.current = dbHandle;
    await act(async () => {
      view.rerender(<EmbeddingHostRuntime />);
    });
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    stopped.resolve();
    await waitFor(() => expect(disposeQueryEmbeddingServiceMock).toHaveBeenCalledTimes(1));
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).toEqual([oldService]);
    disposed.resolve();
    await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    await expect(manager.queryEmbedding(QUERY)).resolves.toEqual([0.1, 0.2]);
    expect(initializeWithModelMock).toHaveBeenCalledTimes(2);
    expect(disposeQueryEmbeddingServiceMock.mock.contexts).toEqual([oldService]);
  });

  it('delivers a query after immediate component replacement with a ready database', async () => {
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
