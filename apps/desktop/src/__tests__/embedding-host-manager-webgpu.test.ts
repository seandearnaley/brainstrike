import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT } from '../embedding-host-shared';
import {
  assertEmbeddingHostWebGpuAdapterRequest,
  createEmbeddingHostWebGpuAdapterErrorReport,
  createEmbeddingHostWebGpuAdapterResultReport,
  type EmbeddingHostWebGpuAdapterRequest,
} from '../embedding-host-webgpu-adapter';
import {
  createEmbeddingHostManager,
  currentLifecycleStatus,
  lifecycleState,
  mockHostWindow,
} from './embedding-host-manager-fixture';

describe('EmbeddingHostManager WebGPU availability (BST-1993)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    currentLifecycleStatus.lastError = null;
    currentLifecycleStatus.runtimeId = 'embedding-host-runtime';
    currentLifecycleStatus.state = 'stopped';
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  const running = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host' as const,
    state: 'running' as const,
  };

  function sentRequest(): EmbeddingHostWebGpuAdapterRequest {
    const call = mockHostWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT
    );
    if (!call) {
      throw new Error('Expected a WebGPU adapter request to the host');
    }
    return assertEmbeddingHostWebGpuAdapterRequest(call[1]);
  }

  it('starts the host on demand and returns the answer to its own request', async () => {
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const manager = createEmbeddingHostManager();
    const detected = manager.webgpuAdapter();
    await vi.waitFor(() => sentRequest());
    const request = sentRequest();
    // A response for another request or from another renderer settles nothing.
    manager.acceptWebGpuAdapterResponseReport(
      mockHostWindow.webContents.id + 1,
      createEmbeddingHostWebGpuAdapterResultReport(request, { available: false, reason: 'x' })
    );
    manager.acceptWebGpuAdapterResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostWebGpuAdapterResultReport(
        { ...request, requestId: 'another-request' },
        { available: false, reason: 'x' }
      )
    );
    const detection = { available: true, reason: 'WebGPU acceleration available (Apple M3)' };
    manager.acceptWebGpuAdapterResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostWebGpuAdapterResultReport(request, detection)
    );
    await expect(detected).resolves.toEqual(detection);
    expect(lifecycleState.ensureStarted).toHaveBeenCalledExactlyOnceWith({ waitForRunning: true });
    // Only the request: opening settings never admits the legacy worker (no start-background).
    expect(mockHostWindow.webContents.send).toHaveBeenCalledOnce();
  });

  it('rejects with the detection failure or a failed start', async () => {
    const manager = createEmbeddingHostManager();
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const failing = manager.webgpuAdapter();
    await vi.waitFor(() => sentRequest());
    manager.acceptWebGpuAdapterResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostWebGpuAdapterErrorReport(sentRequest(), new Error('requestAdapter threw'))
    );
    await expect(failing).rejects.toThrow('requestAdapter threw');
    lifecycleState.ensureStarted.mockResolvedValueOnce({
      ...running,
      lastError: 'host crashed',
      state: 'error',
    });
    await expect(manager.webgpuAdapter()).rejects.toThrow('host crashed');
  });
});
