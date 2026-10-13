import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  lifecycleCallbacks,
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

  afterEach(() => {
    vi.useRealTimers();
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
    for (const other of [
      { ...request, requestId: 'another-request' },
      { ...request, runtimeId: 'superseded-runtime' },
    ]) {
      manager.acceptWebGpuAdapterResponseReport(
        mockHostWindow.webContents.id,
        createEmbeddingHostWebGpuAdapterResultReport(other, { available: false, reason: 'x' })
      );
    }
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

  // The exchange is the shared host request channel: the query requests' deadline and the
  // lifecycle's reject-all settle it, so Settings shows a failure instead of waiting forever.
  it('refuses a host that never answers at the host request deadline', async () => {
    vi.useFakeTimers();
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const manager = createEmbeddingHostManager();
    const detected = manager.webgpuAdapter();
    let settled = false;
    const refused = expect(
      detected.finally(() => {
        settled = true;
      })
    ).rejects.toThrow(/timed out after 60000ms/u);
    await vi.advanceTimersByTimeAsync(0);
    sentRequest();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
  });

  it('refuses a pending detection when the host window closes', async () => {
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const manager = createEmbeddingHostManager();
    const detected = manager.webgpuAdapter();
    await vi.waitFor(() => sentRequest());
    if (!lifecycleCallbacks.current) {
      throw new Error('Expected the manager to register lifecycle callbacks');
    }
    lifecycleCallbacks.current.onWindowClosed();
    await expect(detected).rejects.toThrow('Embedding host window closed');
  });
});
