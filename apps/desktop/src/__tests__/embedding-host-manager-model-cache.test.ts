import type { ModelCachePlan } from '@brainstrike/indexing-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingHostModelCacheRequest,
  createEmbeddingHostModelCacheErrorReport,
  createEmbeddingHostModelCacheResultReport,
  type EmbeddingHostModelCacheRequest,
} from '../embedding-host-model-cache';
import { EMBEDDING_HOST_MODEL_CACHE_STATUS_REQUEST_EVENT } from '../embedding-host-shared';
import {
  createEmbeddingHostManager,
  currentLifecycleStatus,
  lifecycleCallbacks,
  lifecycleState,
  mockHostWindow,
} from './embedding-host-manager-fixture';

const PLANS: readonly ModelCachePlan[] = [
  { device: 'wasm', dtype: 'q8', modelId: 'granite', revision: '0'.repeat(40) },
  { device: 'wasm', dtype: 'q4', modelId: 'minilm' },
];

describe('EmbeddingHostManager model cache status (BST-2241)', () => {
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

  function sentRequest(): EmbeddingHostModelCacheRequest {
    const call = mockHostWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === EMBEDDING_HOST_MODEL_CACHE_STATUS_REQUEST_EVENT
    );
    if (!call) {
      throw new Error('Expected a model cache request to the host');
    }
    return assertEmbeddingHostModelCacheRequest(call[1]);
  }

  it('asks the running host about the plans and returns the answer to its own request', async () => {
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const manager = createEmbeddingHostManager();
    const status = manager.settingsReads.modelCacheStatus(PLANS);
    await vi.waitFor(() => sentRequest());
    const request = sentRequest();
    expect(request.payload.plans).toEqual(PLANS);
    // A response from another renderer, request or runtime settles nothing.
    manager.settingsReads.acceptModelCacheStatusResponseReport(
      mockHostWindow.webContents.id + 1,
      createEmbeddingHostModelCacheResultReport(request, [false, false])
    );
    for (const other of [
      { ...request, requestId: 'another-request' },
      { ...request, runtimeId: 'superseded-runtime' },
    ]) {
      manager.settingsReads.acceptModelCacheStatusResponseReport(
        mockHostWindow.webContents.id,
        createEmbeddingHostModelCacheResultReport(other, [false, false])
      );
    }
    manager.settingsReads.acceptModelCacheStatusResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostModelCacheResultReport(request, [true, false])
    );

    await expect(status).resolves.toEqual([true, false]);
    // Only the request: reading the cache never admits the background worker.
    expect(mockHostWindow.webContents.send).toHaveBeenCalledOnce();
  });

  it('rejects with the host’s cache failure, or an answer for a different number of plans', async () => {
    lifecycleState.ensureStarted.mockResolvedValue(running);
    const manager = createEmbeddingHostManager();
    const failing = manager.settingsReads.modelCacheStatus(PLANS);
    await vi.waitFor(() => sentRequest());
    manager.settingsReads.acceptModelCacheStatusResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostModelCacheErrorReport(sentRequest(), new Error('worker failed'))
    );
    await expect(failing).rejects.toThrow('worker failed');

    mockHostWindow.webContents.send.mockReset();
    const short = manager.settingsReads.modelCacheStatus(PLANS);
    await vi.waitFor(() => sentRequest());
    manager.settingsReads.acceptModelCacheStatusResponseReport(
      mockHostWindow.webContents.id,
      createEmbeddingHostModelCacheResultReport(sentRequest(), [true])
    );
    await expect(short).rejects.toThrow('different number of model cache plans');
  });

  it('starts nothing for an empty catalog', async () => {
    const manager = createEmbeddingHostManager();

    await expect(manager.settingsReads.modelCacheStatus([])).resolves.toEqual([]);
    expect(lifecycleState.ensureStarted).not.toHaveBeenCalled();
  });

  it('refuses a pending read when the host window closes', async () => {
    lifecycleState.ensureStarted.mockResolvedValueOnce(running);
    const manager = createEmbeddingHostManager();
    const status = manager.settingsReads.modelCacheStatus(PLANS);
    await vi.waitFor(() => sentRequest());
    if (!lifecycleCallbacks.current) {
      throw new Error('Expected the manager to register lifecycle callbacks');
    }
    lifecycleCallbacks.current.onWindowClosed();
    await expect(status).rejects.toThrow('Embedding host window closed');
  });
});
