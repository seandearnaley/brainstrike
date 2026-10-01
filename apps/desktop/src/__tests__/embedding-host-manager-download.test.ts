import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockHostWindow, lifecycleState } = vi.hoisted(() => {
  const mockHostWindow = { isDestroyed: () => false, webContents: { id: 91, send: vi.fn() } };
  const status = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host',
    state: 'running',
  };
  return {
    lifecycleState: {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: async () => status,
      getHostWindow: () => mockHostWindow,
      getStatus: () => status,
      setStatus: vi.fn(),
      waitForStatus: async () => ({ ...status, state: 'stopped' }),
    },
    mockHostWindow,
  };
});
vi.mock('electron', () => ({
  app: { getAppPath: () => '/test', isPackaged: false },
  BrowserWindow: vi.fn(),
  powerSaveBlocker: { isStarted: () => false },
}));
vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';

describe('EmbeddingHostManager downloads', () => {
  beforeEach(() => vi.clearAllMocks());
  it('routes download progress without completing the request and awaits its exact completion', async () => {
    const manager = new EmbeddingHostManager();
    const onProgress = vi.fn();
    let completed = false;
    const download = manager
      .downloadModel({ modelId: 'model-a', requestId: 'download-a' }, { onProgress })
      .then(() => {
        completed = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:query-embedding-request',
      expect.objectContaining({ channel: 'download-model', requestId: 'download-a' })
    );
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'download-progress',
      payload: { progress: 99 },
      requestId: 'download-a',
      runtimeId: 'embedding-host-runtime',
      type: 'result',
    });
    expect(onProgress).toHaveBeenCalledWith(99);
    await Promise.resolve();
    expect(completed).toBe(false);
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'download-complete',
      payload: {},
      requestId: 'download-a',
      runtimeId: 'stale-runtime',
      type: 'result',
    });
    expect(completed).toBe(false);
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'download-complete',
      payload: {},
      requestId: 'download-a',
      runtimeId: 'embedding-host-runtime',
      type: 'result',
    });
    await download;
    expect(completed).toBe(true);
    await manager.dispose();
  });

  it('cancels the exact pending download request on public abort', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const download = manager.downloadModel(
      { modelId: 'model-a', requestId: 'download-a' },
      { signal: controller.signal }
    );
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:query-embedding-request',
      expect.objectContaining({ requestId: 'download-a' })
    );
    controller.abort(new Error('Stop'));
    await expect(download).rejects.toBe(controller.signal.reason);
    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:query-embedding-cancel',
      expect.objectContaining({ requestId: 'download-a', runtimeId: 'embedding-host-runtime' })
    );
    await manager.dispose();
  });
});
