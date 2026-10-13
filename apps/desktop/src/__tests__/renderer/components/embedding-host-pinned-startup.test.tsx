import './embedding-host-runtime-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS } from '@brainstrike/vector-management';
import {
  createBackgroundRuntimeStatus,
  createRuntimeStatusStore,
} from '@brainstrike/worker-runtime';
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
  EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT,
  type EmbeddingHostStatus,
} from '../../../embedding-host-shared';
import { assertEmbeddingHostWebGpuAdapterResponseReport } from '../../../embedding-host-webgpu-adapter';
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
  reportWebgpuAdapterResponseMock,
  retireEmbeddingQueueMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
  webgpuAdapterListenerRef,
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
    runtime: { device: plan.device, dtype: plan.dtype, fallbackApplied: false, pooling: 'mean' },
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
  reportWebgpuAdapterResponseMock.mockImplementation((response: unknown) =>
    manager.acceptWebGpuAdapterResponseReport(
      hostWindow.webContents.id,
      assertEmbeddingHostWebGpuAdapterResponseReport(response)
    )
  );
  hostWindow.webContents.send.mockImplementation((channel: string, value: unknown) => {
    if (channel === EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT) {
      documentEmbeddingsListenerRef.current?.(value);
    } else if (channel === EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT) {
      queryEmbeddingListenerRef.current?.(value);
    } else if (channel === EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT) {
      webgpuAdapterListenerRef.current?.(value);
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

  it('answers WebGPU detection on demand, whatever the saved device, without loading a model (BST-1993)', async () => {
    const manager = connect();
    storeState.devicePref = 'wasm';
    storeState.devicePrefConfigured = true;
    detectDeviceCapabilitiesMock.mockResolvedValue({
      detectedAt: 1,
      recommendationReason: 'WebGPU acceleration available (Apple M3)',
      recommendedDevice: 'webgpu',
      wasmAvailable: true,
      webgpuAdapterAvailable: true,
      webgpuAdapterInfo: null,
      webgpuApiPresent: true,
      webgpuUnavailableReason: null,
      webWorkersAvailable: true,
    });
    const detected = manager.webgpuAdapter();
    await mount();
    await expect(detected).resolves.toEqual({
      available: true,
      reason: 'WebGPU acceleration available (Apple M3)',
    });
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(ensureVectorPreferencesHydratedMock).not.toHaveBeenCalled();
  });

  it('reports a software adapter as unavailable with the detection reason (BST-1993)', async () => {
    const manager = connect();
    detectDeviceCapabilitiesMock.mockResolvedValue({
      detectedAt: 1,
      recommendationReason: 'WASM recommended (WebGPU using software fallback would be slower)',
      recommendedDevice: 'wasm',
      wasmAvailable: true,
      webgpuAdapterAvailable: true,
      webgpuAdapterInfo: null,
      webgpuApiPresent: true,
      webgpuUnavailableReason: null,
      webWorkersAvailable: true,
    });
    const detected = manager.webgpuAdapter();
    await mount();
    await expect(detected).resolves.toEqual({
      available: false,
      reason: 'WASM recommended (WebGPU using software fallback would be slower)',
    });
  });

  it('refuses with the detection failure instead of guessing availability (BST-1993)', async () => {
    const manager = connect();
    detectDeviceCapabilitiesMock.mockRejectedValue(new Error('GPU process crashed'));
    const detected = manager.webgpuAdapter();
    onTestFinished(() =>
      detected.then(
        () => {},
        () => {}
      )
    );
    await mount();
    await expect(detected).rejects.toThrow('WebGPU detection failed: GPU process crashed');
  });

  it('reports only statuses the visible renderer accepts, also after WebGPU detection (BST-1993)', async () => {
    const manager = connect();
    const detected = manager.webgpuAdapter();
    await mount();
    await expect(detected).resolves.toMatchObject({ available: true });
    // The visible renderer's shared runtime store (useEmbeddingRuntimeController)
    // throws on any non-canonical field; the smoke saw it reject "webgpuAdapter".
    const store = createRuntimeStatusStore(
      createBackgroundRuntimeStatus('embedding-host', 'embedding-host:stopped', 'stopped'),
      { allowedExtensionKeys: EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS }
    );
    const reported = reportStatusMock.mock.calls.map(([status]) => status as EmbeddingHostStatus);
    expect(reported.length).toBeGreaterThan(0);
    for (const status of [...reported, manager.getStatus()]) {
      const { commandId: _commandId, ...runtimeStatus } = status;
      expect(() => store.setStatus(runtimeStatus)).not.toThrow();
    }
  });

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
