import './embedding-host-runtime-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import {
  assertEmbeddingHostDocumentEmbeddingsResponseReport,
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  createHostWindowMock,
  detectDeviceCapabilitiesMock,
  documentEmbeddingsListenerRef,
  ensureVectorPreferencesHydratedMock,
  generateDocumentEmbeddingsMock,
  generateQueryEmbeddingMock,
  hostWindow,
  initializeMock,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  reportDocumentEmbeddingsResponseMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} from './embedding-host-runtime-fixture';

const plan = {
  device: 'wasm' as const,
  dimensions: 384,
  dtype: 'q8' as const,
  modelId: 'Xenova/all-MiniLM-L6-v2',
};
const payload = {
  dimensions: plan.dimensions,
  inferencePlan: plan,
  modelId: plan.modelId,
  modelKey: `local::${plan.modelId}`,
};
function result(): EmbeddingResult {
  return {
    dimensions: plan.dimensions,
    embedding: Array.from({ length: plan.dimensions }, () => 0.1),
    model: plan.modelId,
    runtime: { device: plan.device, dtype: plan.dtype, fallbackApplied: false },
  };
}
function connect(): EmbeddingHostManager {
  configureDesktopRendererTarget({
    kind: 'dev-renderer',
    launchMode: 'dev-server',
    url: 'http://localhost',
  });
  const manager = new EmbeddingHostManager({ platform: 'win32' });
  reportStatusMock.mockImplementation((status: unknown) =>
    manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
  );
  reportDocumentEmbeddingsResponseMock.mockImplementation((response: unknown) =>
    manager.acceptDocumentEmbeddingsResponseReport(
      hostWindow.webContents.id,
      assertEmbeddingHostDocumentEmbeddingsResponseReport(response)
    )
  );
  reportQueryEmbeddingResponseMock.mockImplementation((response: unknown) =>
    manager.acceptQueryEmbeddingResponseReport(
      hostWindow.webContents.id,
      assertEmbeddingHostQueryEmbeddingResponseReport(response)
    )
  );
  hostWindow.webContents.send.mockImplementation((channel: string, value: unknown) => {
    if (channel === EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT) {
      documentEmbeddingsListenerRef.current?.(value);
    } else if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT) {
      queryEmbeddingListenerRef.current?.(value);
    } else {
      commandListenerRef.current?.(value);
    }
  });
  onTestFinished(async () => {
    hostWindow.destroy();
    await manager.dispose();
    configureDesktopRendererTarget(null);
  });
  return manager;
}
async function mount(): Promise<void> {
  await waitFor(() => expect(hostWindow.loadURL).toHaveBeenCalled());
  const view = render(<EmbeddingHostRuntime />);
  onTestFinished(() => view.unmount());
}

describe('pinned native hidden-host startup', () => {
  installEmbeddingHostRuntimeFixture();

  it.each(['document', 'query'] as const)(
    'starts a cold %s request without legacy device hydration',
    async (kind) => {
      const manager = connect();
      // The real failing profile had no configured legacy device. Native settings
      // already supplied WASM/Q8; legacy preference access must not be involved.
      storeState.devicePrefConfigured = false;
      storeState.hasHydrated = false;
      generateDocumentEmbeddingsMock.mockResolvedValue([result()]);
      generateQueryEmbeddingMock.mockResolvedValue(result());
      const response =
        kind === 'document'
          ? manager.documentEmbeddings({ ...payload, texts: ['document'] })
          : manager.queryEmbedding({ ...payload, query: 'query' });
      onTestFinished(() =>
        response.then(
          () => {},
          () => {}
        )
      );
      await mount();
      await expect(response).resolves.toEqual(
        kind === 'document' ? [result().embedding] : result().embedding
      );
      expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining(plan));
      expect(ensureVectorPreferencesHydratedMock).not.toHaveBeenCalled();
      expect(detectDeviceCapabilitiesMock).not.toHaveBeenCalled();
      expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
      await act(async () => {
        await manager.stop();
      });
      expect(retireEmbeddingQueueMock).toHaveBeenCalledOnce();
    }
  );

  it.each(['running', 'error'] as const)(
    'preserves an in-flight native batch when background startup reports %s',
    async (state) => {
      const manager = connect();
      const generated = Promise.withResolvers<EmbeddingResult[]>();
      generateDocumentEmbeddingsMock.mockReturnValueOnce(generated.promise);
      const response = manager.documentEmbeddings({ ...payload, texts: ['document'] });
      onTestFinished(() => {
        generated.resolve([result()]);
        return response.then(
          () => {},
          () => {}
        );
      });
      await mount();
      await waitFor(() => expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce());
      const runtimeId = manager.getStatus().runtimeId;
      storeState.hasHydrated = true;
      storeState.devicePref = 'webgpu';
      if (state === 'error') {
        storeState.devicePrefConfigured = false;
        detectDeviceCapabilitiesMock.mockResolvedValue({
          recommendedDevice: 'wasm',
          webgpuAdapterAvailable: false,
          webgpuApiPresent: false,
          webWorkersAvailable: true,
        });
      }
      await act(async () => {
        await expect(manager.ensureStarted()).resolves.toMatchObject({ runtimeId, state });
      });
      if (state === 'running') {
        expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
          expect.objectContaining({ device: 'webgpu' })
        );
      } else {
        expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
      }
      expect(manager.getStatus()).toMatchObject({ active: true, runtimeId, state: 'running' });
      expect(createHostWindowMock).toHaveBeenCalledOnce();
      expect(retireEmbeddingQueueMock).not.toHaveBeenCalled();
      generated.resolve([result()]);
      await expect(response).resolves.toEqual([result().embedding]);
      generateDocumentEmbeddingsMock.mockResolvedValueOnce([result()]);
      await expect(
        manager.documentEmbeddings({ ...payload, texts: ['second document'] })
      ).resolves.toEqual([result().embedding]);
      expect(manager.getStatus()).toMatchObject({ runtimeId, state: 'running' });
      expect(createHostWindowMock).toHaveBeenCalledOnce();
      if (state === 'error') {
        storeState.devicePrefConfigured = true;
        storeState.devicePref = 'webgpu';
        await act(async () => {
          await expect(manager.ensureStarted()).resolves.toMatchObject({
            runtimeId,
            state: 'running',
          });
        });
        expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
        expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
          expect.objectContaining({ device: 'webgpu' })
        );
        expect(createHostWindowMock).toHaveBeenCalledOnce();
      }
      await act(async () => {
        await manager.stop();
      });
    }
  );

  it('joins Stop during background startup and never acknowledges a stale running owner', async () => {
    const manager = connect();
    generateDocumentEmbeddingsMock.mockResolvedValue([result()]);
    const response = manager.documentEmbeddings({ ...payload, texts: ['document'] });
    onTestFinished(() =>
      response.then(
        () => {},
        () => {}
      )
    );
    await mount();
    await response;
    const hydration = Promise.withResolvers<typeof storeState>();
    ensureVectorPreferencesHydratedMock.mockReturnValueOnce(hydration.promise);
    const background = manager.ensureStarted();
    onTestFinished(() => {
      hydration.resolve(storeState);
      return background.then(
        () => {},
        () => {}
      );
    });
    await waitFor(() => expect(ensureVectorPreferencesHydratedMock).toHaveBeenCalledOnce());
    const physical = Promise.withResolvers<void>();
    retireEmbeddingQueueMock.mockReturnValueOnce(physical.promise);
    onTestFinished(() => physical.resolve());
    let startSettled = false;
    void background.then(() => {
      startSettled = true;
    });
    const stopped = manager.stop();
    const reportsAtStop = reportStatusMock.mock.calls.length;
    storeState.hasHydrated = true;
    await act(async () => {
      hydration.resolve(storeState);
    });
    expect(startSettled).toBe(false);
    physical.resolve();
    await act(async () => {
      await expect(stopped).resolves.toMatchObject({ state: 'stopped' });
      await expect(background).resolves.toMatchObject({ state: 'stopped' });
    });
    expect(manager.getStatus().state).toBe('stopped');
    expect(retireEmbeddingQueueMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(reportStatusMock.mock.calls.slice(reportsAtStop)).not.toContainEqual([
      expect.objectContaining({ commandId: expect.any(String), state: 'running' }),
    ]);
  });
});
