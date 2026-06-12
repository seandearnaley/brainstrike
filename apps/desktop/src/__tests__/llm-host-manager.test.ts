import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentLifecycleStatus, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 71,
      send: vi.fn(),
    },
  };
  const currentStatus = {
    active: false,
    lastError: null,
    runtimeId: 'llm-host-runtime',
    runtimeKind: 'llm-host' as const,
    state: 'running' as const,
  };

  return {
    currentLifecycleStatus: currentStatus,
    lifecycleState: {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'llm-host-runtime',
        runtimeKind: 'llm-host' as const,
        state: 'running' as const,
      })),
      getHostWindow: vi.fn(() => hostWindow),
      getStatus: vi.fn(() => ({ ...currentStatus })),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn((status) => {
        currentStatus.active = status.active;
        currentStatus.lastError = status.lastError;
        currentStatus.runtimeId = status.runtimeId;
        currentStatus.runtimeKind = status.runtimeKind ?? 'llm-host';
        currentStatus.state = status.state;
      }),
    },
    mockHostWindow: hostWindow,
  };
});

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

const { mockVisibleWindow } = vi.hoisted(() => ({
  mockVisibleWindow: {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 5,
      send: vi.fn(),
    },
  },
}));

vi.mock('electron', () => ({
  // biome-ignore lint/style/useNamingConvention: electron export name
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mockVisibleWindow]),
  },
}));

import { LlmHostManager } from '../llm-host-manager';
import { assertLlmHostRequest } from '../llm-host-shared';

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
  preCancelledRequestIds: Set<string>;
};

describe('LlmHostManager', () => {
  function createRequester(id = 101): WebContents {
    return {
      id,
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
      runtimeKind: 'llm-host',
      state: 'running',
    });
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    lifecycleState.getStatus.mockImplementation(() => ({ ...currentLifecycleStatus }));
    currentLifecycleStatus.active = false;
    currentLifecycleStatus.lastError = null;
    currentLifecycleStatus.runtimeId = 'llm-host-runtime';
    currentLifecycleStatus.runtimeKind = 'llm-host';
    currentLifecycleStatus.state = 'running';
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  it('extends request lifetime while llm-host progress reports are still arriving', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(101);

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
      requestId: '101:req-progress',
      runtimeId: 'llm-host-runtime',
      payload: {
        kind: 'stage',
        message: 'still working',
      },
    });

    await vi.advanceTimersByTimeAsync(59_000);

    expect(manager.pendingRequests.has('101:req-progress')).toBe(true);
    expect(requester.send).toHaveBeenCalledWith(
      expect.stringContaining('progress'),
      expect.objectContaining({
        requestId: '101:req-progress',
        type: 'progress',
      })
    );

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: '101:req-progress',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'done' },
      },
    });

    await expect(requestPromise).resolves.toEqual({ text: 'done' });
  });

  it('clears pre-cancelled request timers and listeners on dispose', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(501);

    // Force the not-running path so cancel() records a pre-cancelled request
    // (a TTL setTimeout + a requester 'destroyed' listener) instead of dispatching.
    lifecycleState.getHostWindow.mockReturnValue(null);

    await manager.cancel(requester, 'req-1');

    expect(manager.preCancelledRequestIds.size).toBe(1);
    expect(requester.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(requester.removeListener).not.toHaveBeenCalled();

    await manager.dispose();

    // dispose must clear the pre-cancelled bookkeeping: empty the id set, clear
    // the TTL timer, and remove the requester 'destroyed' listener.
    expect(manager.preCancelledRequestIds.size).toBe(0);
    expect(requester.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });

  it('exposes platform status with pending request count and disposed state', async () => {
    const manager = new LlmHostManager();

    expect(manager.getPlatformStatus()).toMatchObject({
      pendingRequestCount: 0,
      runtimeId: 'llm-host-runtime',
      runtimeKind: 'llm-host',
      sourceState: 'running',
      state: 'idle',
    });

    await manager.dispose();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'llm-host',
      sourceState: 'stopped',
      state: 'disposed',
    });
  });

  it('exposes resetting platform status while a hidden host reset is in flight', async () => {
    let resolveEnsureStarted!: () => void;
    const runningStatus: {
      active: boolean;
      lastError: null;
      runtimeId: string;
      runtimeKind: 'llm-host';
      state: 'running';
    } = {
      active: false,
      lastError: null,
      runtimeId: 'llm-host:next-runtime',
      runtimeKind: 'llm-host',
      state: 'running',
    };
    lifecycleState.ensureStarted.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnsureStarted = () => {
          lifecycleState.setStatus(runningStatus);
          resolve(runningStatus);
        };
      })
    );
    const manager = new LlmHostManager();

    const resetPromise = manager.reset();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'llm-host',
      state: 'resetting',
    });

    resolveEnsureStarted();
    await expect(resetPromise).resolves.toMatchObject({
      runtimeId: 'llm-host:next-runtime',
      state: 'running',
    });
  });

  it('keeps a generation alive past the base timeout while progress keeps arriving (inactivity window)', async () => {
    // The timeout protects against a WEDGED host, not a slow one: a long
    // local generation streams progress snapshots continuously, so each
    // progress report extends the deadline. A hard wall-clock ceiling killed
    // legitimate long prefills at exactly 5 minutes.
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(111);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-long-generation',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    // 3 rounds of 4 minutes with progress between them: 12 minutes total,
    // far past the 5-minute base window — must still be pending.
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      manager.acceptResponseReport(71, {
        type: 'progress',
        channel: 'llm-progress',
        requestId: '111:req-long-generation',
        runtimeId: 'llm-host-runtime',
        payload: {
          kind: 'text',
          text: `cumulative output after round ${round}`,
        },
      });
    }
    expect(manager.pendingRequests.has('111:req-long-generation')).toBe(true);

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: '111:req-long-generation',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'done after 12 minutes' },
      },
    });
    await expect(requestPromise).resolves.toEqual({ text: 'done after 12 minutes' });
  });

  it('times out a generation after the inactivity window passes with NO progress', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(112);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-wedged',
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
      requestId: '112:req-wedged',
      runtimeId: 'llm-host-runtime',
      payload: { kind: 'stage', message: 'one last sign of life' },
    });

    // Silence for the full window after the last progress: the host is wedged.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    await expect(observedRejection).resolves.toMatchObject({
      message: 'Llm host request 112:req-wedged timed out.',
    });
    expect(manager.pendingRequests.has('112:req-wedged')).toBe(false);
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

  it('scopes fallback-generated request ids to the requester', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(401);

    const warmupPromise = manager.warmup(requester, 'onnx-community/gemma-4-E2B-it-ONNX');
    await vi.waitFor(() => {
      expect(manager.pendingRequests.size).toBe(1);
    });
    const [requestId] = [...manager.pendingRequests.keys()];

    expect(requestId?.startsWith('401:')).toBe(true);

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: requestId ?? 'missing',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: null,
      },
    });

    await expect(warmupPromise).resolves.toBeUndefined();
  });

  it('rejects duplicate client request IDs instead of overwriting pending work', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(201);

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

    await expect(duplicateRequest).rejects.toThrow(
      'Duplicate llm host requestId 201:duplicate-id.'
    );
    expect(manager.pendingRequests.has('201:duplicate-id')).toBe(true);

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: '201:duplicate-id',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'done' },
      },
    });

    await expect(firstRequest).resolves.toEqual({ text: 'done' });
  });

  it('scopes client request IDs by requester so different renderers do not collide', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requesterA = createRequester(301);
    const requesterB = createRequester(302);

    const requestA = manager.generate(requesterA, {
      clientRequestId: 'same-id',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const requestB = manager.generate(requesterB, {
      clientRequestId: 'same-id',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    await vi.waitFor(() => {
      expect(manager.pendingRequests.has('301:same-id')).toBe(true);
      expect(manager.pendingRequests.has('302:same-id')).toBe(true);
    });

    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: '301:same-id',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'A' },
      },
    });
    manager.acceptResponseReport(71, {
      type: 'result',
      channel: 'llm-result',
      requestId: '302:same-id',
      runtimeId: 'llm-host-runtime',
      payload: {
        result: { text: 'B' },
      },
    });

    await expect(requestA).resolves.toEqual({ text: 'A' });
    await expect(requestB).resolves.toEqual({ text: 'B' });
  });

  it('rejects client request ids that attempt to smuggle scope separators', async () => {
    const manager = new LlmHostManager();
    const requester = createRequester(317);

    await expect(
      manager.generate(requester, {
        clientRequestId: '317:other:request',
        kind: 'generate',
        messages: [],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        options: {},
      })
    ).rejects.toThrow('must not include nested scope prefixes');
  });

  it('cancels host work and removes requester listeners when a refreshed timeout expires', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(101);

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
      message: 'Llm host request 101:req-timeout timed out.',
    });
    expect(requester.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'cancel',
          requestId: '101:req-timeout',
        }),
      })
    );
  });

  it('treats cancel as a no-op when the host is stopped', async () => {
    const manager = new LlmHostManager();
    const requester = createRequester();
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'stopped',
    });
    lifecycleState.getHostWindow.mockReturnValue(undefined);

    await expect(manager.cancel(requester, 'req-cancel')).resolves.toBeUndefined();

    expect(lifecycleState.ensureStarted).not.toHaveBeenCalled();
    expect(mockHostWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects a request that was cancelled before the host finished starting', async () => {
    let resolveEnsureStarted:
      | ((value: { active: boolean; lastError: null; runtimeId: string; state: 'running' }) => void)
      | null = null;
    lifecycleState.ensureStarted.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnsureStarted = resolve;
        })
    );
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'starting',
    });

    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(501);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'prestart-cancel',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });

    await Promise.resolve();
    await expect(manager.cancel(requester, 'prestart-cancel')).resolves.toBeUndefined();

    resolveEnsureStarted?.({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'running',
    });

    await expect(requestPromise).rejects.toThrow(
      'Llm host request 501:prestart-cancel was cancelled before dispatch.'
    );
    expect(mockHostWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('expires pre-cancelled request ids that are never consumed', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(601);
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'starting',
    });
    lifecycleState.getHostWindow.mockReturnValue(undefined);

    await expect(manager.cancel(requester, 'never-dispatched')).resolves.toBeUndefined();
    expect(manager.preCancelledRequestIds.has('601:never-dispatched')).toBe(true);

    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1);

    expect(manager.preCancelledRequestIds.has('601:never-dispatched')).toBe(false);
  });

  it('purges pre-cancelled request ids immediately when the requester is destroyed', async () => {
    const manager = new LlmHostManager() as TestableLlmHostManager;
    const requester = createRequester(701);
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      state: 'starting',
    });
    lifecycleState.getHostWindow.mockReturnValue(undefined);

    await expect(manager.cancel(requester, 'destroyed-before-dispatch')).resolves.toBeUndefined();
    expect(manager.preCancelledRequestIds.has('701:destroyed-before-dispatch')).toBe(true);

    const destroyedHandler = (
      requester.once as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([eventName]: readonly [string]) => eventName === 'destroyed')?.[1] as
      | (() => void)
      | undefined;

    if (!destroyedHandler) {
      throw new Error('Expected destroyed listener to be registered');
    }

    destroyedHandler();

    expect(manager.preCancelledRequestIds.has('701:destroyed-before-dispatch')).toBe(false);
    expect(requester.removeListener).toHaveBeenCalledWith('destroyed', destroyedHandler);
  });

  describe('main-process client API', () => {
    it('sends envelopes that pass the REAL host-side request validation', async () => {
      // The hidden host runtime rejects payloads without clientRequestId; a
      // manager-generated request that fails assertLlmHostRequest is silently
      // dropped host-side and waits out its full timeout (the "stuck on
      // Thinking" bug). Validate exactly what gets sent over IPC.
      const manager = new LlmHostManager() as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');
      await vi.waitFor(() => {
        expect(mockHostWindow.webContents.send).toHaveBeenCalledTimes(1);
      });
      const generatePromise = manager.generateForMain({
        messages: [{ role: 'user', content: 'hi' }],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      });
      await vi.waitFor(() => {
        expect(mockHostWindow.webContents.send).toHaveBeenCalledTimes(2);
      });

      for (const [, sentRequest] of mockHostWindow.webContents.send.mock.calls) {
        const validated = assertLlmHostRequest(sentRequest);
        expect(validated.payload).toMatchObject({
          clientRequestId: expect.stringMatching(/.+/),
        });
        // The stamped clientRequestId is the unscoped portion of the envelope id.
        expect(`main:${(validated.payload as { clientRequestId?: string }).clientRequestId}`).toBe(
          validated.requestId
        );
      }

      for (const requestId of [...manager.pendingRequests.keys()]) {
        manager.acceptResponseReport(71, {
          type: 'result',
          channel: 'llm-result',
          requestId,
          runtimeId: 'llm-host-runtime',
          payload: {
            result: {
              text: 'ok',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
          },
        });
      }
      await expect(warmupPromise).resolves.toBeUndefined();
      await expect(generatePromise).resolves.toMatchObject({ text: 'ok' });
    });

    it('generateForMain scopes request ids to main, forwards progress, and resolves the result', async () => {
      const manager = new LlmHostManager() as TestableLlmHostManager;
      const progressEvents: unknown[] = [];

      const requestPromise = manager.generateForMain(
        {
          messages: [{ role: 'user', content: 'hi' }],
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          options: {},
        },
        { onProgress: (progress) => progressEvents.push(progress) }
      );

      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      const [requestId] = [...manager.pendingRequests.keys()];
      expect(requestId?.startsWith('main:')).toBe(true);

      manager.acceptResponseReport(71, {
        type: 'progress',
        channel: 'llm-progress',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: { kind: 'text', text: 'partial answer' },
      });
      manager.acceptResponseReport(71, {
        type: 'result',
        channel: 'llm-result',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: {
          result: {
            text: 'final answer',
            finishReason: 'stop',
            usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
          },
        },
      });

      await expect(requestPromise).resolves.toMatchObject({ text: 'final answer' });
      expect(progressEvents).toEqual([{ kind: 'text', text: 'partial answer' }]);
    });

    it('generateForMain rejects and cancels host work when the abort signal fires', async () => {
      const manager = new LlmHostManager() as TestableLlmHostManager;
      const abortController = new AbortController();

      const requestPromise = manager.generateForMain(
        {
          messages: [{ role: 'user', content: 'hi' }],
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          options: {},
        },
        { signal: abortController.signal }
      );
      const observedRejection = requestPromise.then(
        () => null,
        (error: unknown) => error
      );

      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      const [requestId] = [...manager.pendingRequests.keys()];

      abortController.abort();

      await expect(observedRejection).resolves.toMatchObject({
        message: `Llm host request ${requestId} was aborted.`,
      });
      expect(manager.pendingRequests.size).toBe(0);
      expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'cancel', requestId }),
        })
      );
    });

    it('generateForMain throws immediately when the signal is already aborted', async () => {
      const manager = new LlmHostManager();
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        manager.generateForMain(
          {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          },
          { signal: abortController.signal }
        )
      ).rejects.toThrow('Llm host request was aborted before dispatch.');
      expect(mockHostWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('generateForMain rejects a null result payload instead of returning it', async () => {
      const manager = new LlmHostManager() as TestableLlmHostManager;

      const requestPromise = manager.generateForMain({
        messages: [{ role: 'user', content: 'hi' }],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      });
      const observedRejection = requestPromise.then(
        () => null,
        (error: unknown) => error
      );

      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      const [requestId] = [...manager.pendingRequests.keys()];

      manager.acceptResponseReport(71, {
        type: 'result',
        channel: 'llm-result',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: { result: null },
      });

      await expect(observedRejection).resolves.toMatchObject({
        message: expect.stringContaining('returned no result payload'),
      });
    });

    it('broadcasts main-initiated loading progress to visible windows so the UI shows downloads', async () => {
      // Cold MEMORY-model warmups are triggered by the assistant server (main
      // process) with no renderer request in flight; without this broadcast
      // the user stares at a silent spinner while gigabytes download.
      const manager = new LlmHostManager() as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');
      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      const [requestId] = [...manager.pendingRequests.keys()];

      manager.acceptResponseReport(71, {
        type: 'progress',
        channel: 'llm-progress',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: {
          kind: 'loading',
          progress: 42,
          message: 'Downloading model',
          file: 'model.onnx',
        },
      });

      expect(mockVisibleWindow.webContents.send).toHaveBeenCalledWith(
        expect.stringContaining('progress'),
        expect.objectContaining({
          type: 'progress',
          payload: expect.objectContaining({ kind: 'loading', progress: 42 }),
        })
      );

      manager.acceptResponseReport(71, {
        type: 'result',
        channel: 'llm-result',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: { result: null },
      });
      await expect(warmupPromise).resolves.toBeUndefined();

      // Completion broadcasts a terminal 100% so the badge can resolve to
      // ready instead of sticking at the last partial percentage.
      expect(mockVisibleWindow.webContents.send).toHaveBeenCalledWith(
        expect.stringContaining('progress'),
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'loading', progress: 100 }),
        })
      );
    });

    it('does not broadcast renderer-initiated progress a second time', async () => {
      const manager = new LlmHostManager() as TestableLlmHostManager;
      const requester = createRequester(101);

      const requestPromise = manager.generate(requester, {
        clientRequestId: 'req-renderer-progress',
        kind: 'generate',
        messages: [],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        options: {},
      });

      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      manager.acceptResponseReport(71, {
        type: 'progress',
        channel: 'llm-progress',
        requestId: '101:req-renderer-progress',
        runtimeId: 'llm-host-runtime',
        payload: { kind: 'loading', progress: 10 },
      });

      // Renderer callers already receive progress over their own IPC channel.
      expect(mockVisibleWindow.webContents.send).not.toHaveBeenCalled();

      manager.acceptResponseReport(71, {
        type: 'result',
        channel: 'llm-result',
        requestId: '101:req-renderer-progress',
        runtimeId: 'llm-host-runtime',
        payload: { result: { text: 'done' } },
      });
      await expect(requestPromise).resolves.toEqual({ text: 'done' });
    });

    it('warmupForMain resolves when the host acknowledges with a null result', async () => {
      const manager = new LlmHostManager() as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');

      await vi.waitFor(() => {
        expect(manager.pendingRequests.size).toBe(1);
      });
      const [requestId] = [...manager.pendingRequests.keys()];
      expect(requestId?.startsWith('main:')).toBe(true);

      manager.acceptResponseReport(71, {
        type: 'result',
        channel: 'llm-result',
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        payload: { result: null },
      });

      await expect(warmupPromise).resolves.toBeUndefined();
    });
  });
});
