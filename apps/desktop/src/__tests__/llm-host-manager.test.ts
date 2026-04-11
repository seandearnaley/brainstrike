import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 71,
      send: vi.fn(),
    },
  };

  return {
    lifecycleState: {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'llm-host-runtime',
        state: 'running' as const,
      })),
      getHostWindow: vi.fn(() => hostWindow),
      getStatus: vi.fn(() => ({
        active: false,
        lastError: null,
        runtimeId: 'llm-host-runtime',
        state: 'running' as const,
      })),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn(),
    },
    mockHostWindow: hostWindow,
  };
});

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { LlmHostManager } from '../llm-host-manager';

type TestableLlmHostManager = LlmHostManager & {
  acceptResponseReport(
    senderId: number,
    report: {
      channel: string;
      payload: Record<string, unknown>;
      requestId: string;
      runtimeId: string;
      type: string;
    }
  ): void;
  pendingRequests: Map<string, unknown>;
};

describe('LlmHostManager', () => {
  function createRequester(): WebContents {
    return {
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lifecycleState.ensureStarted.mockResolvedValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'running',
    });
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'running',
    });
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  it('extends request lifetime while llm-host progress reports are still arriving', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester();

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-progress',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    await vi.advanceTimersByTimeAsync(59_000);
    manager.acceptResponseReport(71, {
      type: 'progress',
      channel: 'llm-progress',
      requestId: 'req-progress',
      runtimeId: 'llm-host-runtime',
      payload: {
        kind: 'stage',
        message: 'still working',
      },
    });

    await vi.advanceTimersByTimeAsync(59_000);

    expect(manager.pendingRequests.has('req-progress')).toBe(true);
    expect(requester.send).toHaveBeenCalledWith(
      expect.stringContaining('progress'),
      expect.objectContaining({
        requestId: 'req-progress',
        type: 'progress',
      })
    );

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: 'req-progress',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'done' },
      },
    });

    await expect(requestPromise).resolves.toEqual({ text: 'done' });
  });

  it('uses a longer timeout window for warmup requests', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester();

    const warmupPromise = manager.warmup(requester, 'onnx-community/gemma-4-E2B-it-ONNX');

    await vi.advanceTimersByTimeAsync(61_000);

    expect(manager.pendingRequests.size).toBe(1);

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: [...manager.pendingRequests.keys()][0] ?? 'missing',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: null,
      },
    });

    await expect(warmupPromise).resolves.toBeUndefined();
  });

  it('rejects duplicate client request IDs instead of overwriting pending work', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester();

    const firstRequest = manager.generate(requester, {
      clientRequestId: 'duplicate-id',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    const duplicateRequest = manager.generate(requester, {
      clientRequestId: 'duplicate-id',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    await expect(duplicateRequest).rejects.toThrow('Duplicate llm host requestId duplicate-id.');
    expect(manager.pendingRequests.has('duplicate-id')).toBe(true);

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: 'duplicate-id',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'done' },
      },
    });

    await expect(firstRequest).resolves.toEqual({ text: 'done' });
  });

  it('cancels host work and removes requester listeners when a refreshed timeout expires', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester();

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-timeout',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(59_000);
    manager.acceptResponseReport(71, {
      type: 'progress',
      channel: 'llm-progress',
      requestId: 'req-timeout',
      runtimeId: 'llm-host-runtime',
      payload: {
        kind: 'stage',
        message: 'still working',
      },
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    await expect(observedRejection).resolves.toMatchObject({
      message: 'Llm host request req-timeout timed out.',
    });
    expect(requester.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'cancel',
          requestId: 'req-timeout',
        }),
      })
    );
  });
});
