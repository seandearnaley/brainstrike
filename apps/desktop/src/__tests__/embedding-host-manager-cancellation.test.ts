import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lifecycle, windowMock } = vi.hoisted(() => {
  const windowMock = {
    isDestroyed: vi.fn(() => false),
    webContents: { id: 91, send: vi.fn() },
  };
  const status = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host',
    state: 'running',
  };
  return {
    lifecycle: {
      ensureStarted: vi.fn(async () => status),
      getHostWindow: vi.fn(() => windowMock),
      getStatus: vi.fn(() => status),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn(),
    },
    windowMock,
  };
});

vi.mock('electron', () => ({
  powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
}));
vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycle;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';

const QUERY = {
  dimensions: 2,
  modelId: 'local-model',
  modelKey: 'local::local-model',
  query: 'hello',
};

describe('EmbeddingHostManager query cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an already-aborted query without starting the host', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped');
    controller.abort(reason);

    await expect(manager.queryEmbedding(QUERY, { signal: controller.signal })).rejects.toBe(reason);
    expect(lifecycle.ensureStarted).not.toHaveBeenCalled();
    expect(windowMock.webContents.send).not.toHaveBeenCalled();
  });

  it('releases a pending query request when its tool signal aborts', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped');
    const embeddingPromise = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const observedRejection = embeddingPromise.then(
      () => null,
      (error: unknown) => error
    );
    await lifecycle.ensureStarted.mock.results[0]?.value;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);

    controller.abort(reason);
    await expect(observedRejection).resolves.toBe(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
});
