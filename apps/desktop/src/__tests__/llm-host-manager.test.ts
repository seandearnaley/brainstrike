import type { BrowserWindow, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LlmLifecycleStatus {
  active: boolean;
  lastError: string | null;
  runtimeId: string;
  runtimeKind?: 'llm-host';
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

const { currentLifecycleStatus, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 71,
      send: vi.fn(),
    },
  };
  const currentStatus: LlmLifecycleStatus = {
    active: false,
    lastError: null,
    runtimeId: 'llm-host-runtime',
    runtimeKind: 'llm-host',
    state: 'running',
  };

  return {
    currentLifecycleStatus: currentStatus,
    lifecycleState: {
      acceptsStatus: vi.fn(() => true),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn<(options?: unknown) => Promise<LlmLifecycleStatus>>(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'llm-host-runtime',
        runtimeKind: 'llm-host',
        state: 'running',
      })),
      getHostWindow: vi.fn<() => typeof hostWindow | null | undefined>(() => hostWindow),
      getStatus: vi.fn<() => LlmLifecycleStatus>(() => ({ ...currentStatus })),
      isHostWindow: vi.fn(() => false),
      joinPhysicalClose: vi.fn(async () => {}),
      restart: vi.fn(async function (this: { ensureStarted(): Promise<unknown> }) {
        return this.ensureStarted();
      }),
      retire: vi.fn(async function (this: { destroyHostWindow(): Promise<void> }) {
        await this.destroyHostWindow();
      }),
      setStatus: vi.fn<(status: LlmLifecycleStatus) => void>((status) => {
        currentStatus.active = status.active;
        currentStatus.lastError = status.lastError;
        currentStatus.runtimeId = status.runtimeId;
        currentStatus.runtimeKind = status.runtimeKind ?? 'llm-host';
        currentStatus.state = status.state;
      }),
      stop: vi.fn(async function (
        this: { destroyHostWindow(): Promise<void> },
        protocol?: () => Promise<void>
      ) {
        const failures: unknown[] = [];
        try {
          await protocol?.();
        } catch (cause) {
          failures.push(cause);
        }
        try {
          await this.destroyHostWindow();
        } catch (cause) {
          failures.push(cause);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Stop and physical release failed');
        }
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

const { mockHiddenHostWindow, mockVisibleWindow } = vi.hoisted(() => ({
  // A hidden runtime host's window: never a progress destination.
  mockHiddenHostWindow: {
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    webContents: {
      id: 6,
      send: vi.fn(),
    },
  },
  mockVisibleWindow: {
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    webContents: {
      id: 5,
      send: vi.fn(),
    },
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mockVisibleWindow, mockHiddenHostWindow]),
  },
}));

const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: loggerDebugMock,
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

// Restore the real stream/runtime surfaces replaced by the desktop-wide test
// setup so this suite can prove the watchdog-to-manager cancellation chain.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { AssistantDataStreamSession, streamMastraAgent } = await import('@brainstrike/agent');

import { createMainLlmHostClient } from '@brainstrike/assistant-service/ports';
import { LlmHostManager } from '../llm-host-manager';
import { assertLlmHostRequest } from '../llm-host-shared';
import { assignWindowRole } from '../window-role';

type TestableLlmHostManager = Omit<LlmHostManager, never> & {
  acceptResponseReport: (
    senderId: number,
    report: {
      channel: string;
      payload: Record<string, unknown>;
      requestId: string;
      runtimeId: string;
      type: string;
    }
  ) => void;
  preCancelledRequestIds: Set<string>;
  requests: {
    has: (requestId: string) => boolean;
    ids: () => readonly string[];
    size: () => number;
  };
};

function requireResolver<T>(
  resolver: ((value: T) => void) | null,
  description: string
): (value: T) => void {
  if (!resolver) {
    throw new Error(`expected ${description}`);
  }
  return resolver;
}

async function drainResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Expected an assistant response body.');
  }
  const decoder = new TextDecoder();
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return output;
    }
    output += decoder.decode(value, { stream: true });
  }
}

describe('LlmHostManager', () => {
  it('retains independent stop and lifecycle disposal failures', async () => {
    const manager = new LlmHostManager();
    const stopFailure = new Error('Stop acknowledgement lost');
    const releaseFailure = new Error('Physical release failed');
    lifecycleState.stop.mockRejectedValueOnce(stopFailure);
    lifecycleState.dispose.mockRejectedValueOnce(releaseFailure);
    const outcome = await manager.dispose().catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([stopFailure, releaseFailure]);
  });

  function createRequester(id = 101): WebContents {
    return {
      id,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
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
    // Shared across every logger in the module graph (manager + channel), so a
    // stale call from an earlier test would otherwise satisfy a later one.
    loggerWarnMock.mockClear();
    loggerDebugMock.mockClear();
  });

  it('logs a late response for an abandoned request at debug, not warn', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const requester = createRequester(99);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-late',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(observedRejection).resolves.toBeInstanceOf(Error);
    loggerWarnMock.mockClear();

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: { result: { text: 'too late' } },
      requestId: '99:req-late',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    // The manager itself abandoned this id when it timed out, so the host
    // answering a cancel already in flight is expected, not a fault.
    expect(loggerDebugMock).toHaveBeenCalledWith('Llm host answered an abandoned request', {
      requestId: '99:req-late',
    });
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining('no longer pending'),
      expect.anything()
    );
  });

  it('warns for a response whose id this manager never abandoned', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: { result: { text: 'nobody asked' } },
      requestId: '99:req-unknown',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Llm host response arrived for a request that is no longer pending',
      { requestId: '99:req-unknown' }
    );
  });

  it('does not warn per frame when progress trails an abandoned request', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const requester = createRequester(99);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'req-trailing',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(observedRejection).resolves.toBeInstanceOf(Error);
    loggerWarnMock.mockClear();

    // A streaming host has frames in flight when it is cancelled; one
    // cancellation must not become a burst of warnings.
    for (let index = 0; index < 5; index += 1) {
      manager.acceptResponseReport(71, {
        channel: 'llm-progress',
        payload: { kind: 'generation', text: `token-${index}` },
        requestId: '99:req-trailing',
        runtimeId: 'llm-host-runtime',
        type: 'progress',
      });
    }

    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('extends request lifetime while llm-host progress reports are still arriving', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
      channel: 'llm-progress',
      payload: {
        kind: 'stage',
        message: 'still working',
      },
      requestId: '101:req-progress',
      runtimeId: 'llm-host-runtime',
      type: 'progress',
    });

    await vi.advanceTimersByTimeAsync(59_000);

    expect(manager.requests.has('101:req-progress')).toBe(true);
    expect(requester.send).toHaveBeenCalledWith(
      expect.stringContaining('progress'),
      expect.objectContaining({
        requestId: '101:req-progress',
        type: 'progress',
      })
    );

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: { text: 'done' },
      },
      requestId: '101:req-progress',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    await expect(requestPromise).resolves.toEqual({ text: 'done' });
  });

  it('clears pre-cancelled request timers and listeners on dispose', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
        channel: 'llm-progress',
        payload: {
          kind: 'text',
          text: `cumulative output after round ${round}`,
        },
        requestId: '111:req-long-generation',
        runtimeId: 'llm-host-runtime',
        type: 'progress',
      });
    }
    expect(manager.requests.has('111:req-long-generation')).toBe(true);

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: { text: 'done after 12 minutes' },
      },
      requestId: '111:req-long-generation',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });
    await expect(requestPromise).resolves.toEqual({ text: 'done after 12 minutes' });
  });

  it('times out a generation after the inactivity window passes with NO progress', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
      channel: 'llm-progress',
      payload: { kind: 'stage', message: 'one last sign of life' },
      requestId: '112:req-wedged',
      runtimeId: 'llm-host-runtime',
      type: 'progress',
    });

    // Silence for the full window after the last progress: the host is wedged.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    await expect(observedRejection).resolves.toMatchObject({
      message: 'Llm host request 112:req-wedged timed out.',
    });
    expect(manager.requests.has('112:req-wedged')).toBe(false);
  });

  it('uses a longer timeout window for warmup requests', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const requester = createRequester();

    const warmupPromise = manager.warmup(requester, 'onnx-community/gemma-4-E2B-it-ONNX');

    await vi.advanceTimersByTimeAsync(61_000);

    expect(manager.requests.size()).toBe(1);

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: null,
      },
      requestId: manager.requests.ids()[0] ?? 'missing',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    await expect(warmupPromise).resolves.toBeUndefined();
  });

  it('scopes fallback-generated request ids to the requester', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const requester = createRequester(401);

    const warmupPromise = manager.warmup(requester, 'onnx-community/gemma-4-E2B-it-ONNX');
    await vi.waitFor(() => {
      expect(manager.requests.size()).toBe(1);
    });
    const [requestId] = manager.requests.ids();

    expect(requestId?.startsWith('401:')).toBe(true);

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: null,
      },
      requestId: requestId ?? 'missing',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    await expect(warmupPromise).resolves.toBeUndefined();
  });

  it('rejects duplicate client request IDs instead of overwriting pending work', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
      'Llm host request 201:duplicate-id is already in flight.'
    );
    expect(manager.requests.has('201:duplicate-id')).toBe(true);

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: { text: 'done' },
      },
      requestId: '201:duplicate-id',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });

    await expect(firstRequest).resolves.toEqual({ text: 'done' });
  });

  it('scopes client request IDs by requester so different renderers do not collide', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
      expect(manager.requests.has('301:same-id')).toBe(true);
      expect(manager.requests.has('302:same-id')).toBe(true);
    });

    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: { text: 'A' },
      },
      requestId: '301:same-id',
      runtimeId: 'llm-host-runtime',
      type: 'result',
    });
    manager.acceptResponseReport(71, {
      channel: 'llm-result',
      payload: {
        result: { text: 'B' },
      },
      requestId: '302:same-id',
      runtimeId: 'llm-host-runtime',
      type: 'result',
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
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
      channel: 'llm-progress',
      payload: {
        kind: 'stage',
        message: 'still working',
      },
      requestId: 'req-timeout',
      runtimeId: 'llm-host-runtime',
      type: 'progress',
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

    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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

    requireResolver(
      resolveEnsureStarted,
      'ensureStarted resolver'
    )({
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
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
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
    ).mock.calls.find((call) => call[0] === 'destroyed')?.[1] as (() => void) | undefined;

    if (!destroyedHandler) {
      throw new Error('Expected destroyed listener to be registered');
    }

    destroyedHandler();

    expect(manager.preCancelledRequestIds.has('701:destroyed-before-dispatch')).toBe(false);
    expect(requester.removeListener).toHaveBeenCalledWith('destroyed', destroyedHandler);
  });

  it('retires the faulted runtime without rearming the automatic restart budget', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const resetSpy = vi.spyOn(manager, 'reset');
    const requester = createRequester(801);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'engine-fault',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => {
      expect(manager.requests.has('801:engine-fault')).toBe(true);
    });

    manager.acceptResponseReport(71, {
      channel: 'llm-error',
      payload: {
        errorDetails: { engineReset: true, stage: 'generate-response' },
        errorMessage:
          'failed to call OrtRun() — the local model engine was reset; the next message will reload the model.',
      },
      requestId: '801:engine-fault',
      runtimeId: 'llm-host-runtime',
      type: 'error',
    });

    const failure = await observedRejection;
    expect(failure).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(lifecycleState.retire).toHaveBeenCalledWith(failure, 'llm-host-runtime');
    });
    expect(resetSpy).not.toHaveBeenCalled();
    expect(lifecycleState.restart).not.toHaveBeenCalled();
  });

  it('does NOT reset the host window for an ordinary (non-engine) request failure', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const resetSpy = vi.spyOn(manager, 'reset').mockResolvedValue({
      active: false,
      lastError: null,
      runtimeId: 'llm-host-runtime',
      runtimeKind: 'llm-host',
      state: 'running',
    });
    const requester = createRequester(802);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'plain-failure',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => {
      expect(manager.requests.has('802:plain-failure')).toBe(true);
    });

    manager.acceptResponseReport(71, {
      channel: 'llm-error',
      payload: {
        errorDetails: { stage: 'generate-response' },
        errorMessage: 'Tool arguments failed validation.',
      },
      requestId: '802:plain-failure',
      runtimeId: 'llm-host-runtime',
      type: 'error',
    });

    await expect(observedRejection).resolves.toBeInstanceOf(Error);
    await Promise.resolve();
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('preserves a typed local generation error across the hidden-host boundary', async () => {
    const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
    const requester = createRequester(803);

    const requestPromise = manager.generate(requester, {
      clientRequestId: 'malformed-tool-call',
      kind: 'generate',
      messages: [],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: {},
    });
    const observedRejection = requestPromise.then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => {
      expect(manager.requests.has('803:malformed-tool-call')).toBe(true);
    });

    manager.acceptResponseReport(71, {
      channel: 'llm-error',
      payload: {
        code: 'local_tool_call_arguments_invalid',
        errorDetails: { stage: 'generate-response' },
        errorMessage:
          'local_tool_call_arguments_invalid: The local model produced malformed JSON arguments for a tool call.',
      },
      requestId: '803:malformed-tool-call',
      runtimeId: 'llm-host-runtime',
      type: 'error',
    });

    await expect(observedRejection).resolves.toMatchObject({
      code: 'local_tool_call_arguments_invalid',
      message: expect.stringContaining('local_tool_call_arguments_invalid'),
    });
  });

  describe('main-process client API', () => {
    it('sends envelopes that pass the REAL host-side request validation', async () => {
      // The hidden host runtime rejects payloads without clientRequestId; a
      // manager-generated request that fails assertLlmHostRequest is silently
      // dropped host-side and waits out its full timeout (the "stuck on
      // Thinking" bug). Validate exactly what gets sent over IPC.
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');
      await vi.waitFor(() => {
        expect(mockHostWindow.webContents.send).toHaveBeenCalledTimes(1);
      });
      const generatePromise = manager.generateForMain({
        messages: [{ content: 'hi', role: 'user' }],
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

      for (const requestId of manager.requests.ids()) {
        manager.acceptResponseReport(71, {
          channel: 'llm-result',
          payload: {
            result: {
              finishReason: 'stop',
              text: 'ok',
              usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
            },
          },
          requestId,
          runtimeId: 'llm-host-runtime',
          type: 'result',
        });
      }
      await expect(warmupPromise).resolves.toBeUndefined();
      await expect(generatePromise).resolves.toMatchObject({ text: 'ok' });
    });

    it('generateForMain scopes request ids to main, forwards progress, and resolves the result', async () => {
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
      const progressEvents: unknown[] = [];

      const requestPromise = manager.generateForMain(
        {
          messages: [{ content: 'hi', role: 'user' }],
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          options: {},
        },
        { onProgress: (progress: unknown) => progressEvents.push(progress) }
      );

      await vi.waitFor(() => {
        expect(manager.requests.size()).toBe(1);
      });
      const [requestId] = manager.requests.ids();
      expect(requestId?.startsWith('main:')).toBe(true);

      manager.acceptResponseReport(71, {
        channel: 'llm-progress',
        payload: { kind: 'text', text: 'partial answer' },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'progress',
      });
      manager.acceptResponseReport(71, {
        channel: 'llm-result',
        payload: {
          result: {
            finishReason: 'stop',
            text: 'final answer',
            usage: { completionTokens: 2, promptTokens: 4, totalTokens: 6 },
          },
        },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'result',
      });

      await expect(requestPromise).resolves.toMatchObject({ text: 'final answer' });
      expect(progressEvents).toEqual([{ kind: 'text', text: 'partial answer' }]);
    });

    it('generateForMain rejects and cancels host work when the abort signal fires', async () => {
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
      const abortController = new AbortController();

      const requestPromise = manager.generateForMain(
        {
          messages: [{ content: 'hi', role: 'user' }],
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
        expect(manager.requests.size()).toBe(1);
      });
      const [requestId] = manager.requests.ids();

      abortController.abort();

      await expect(observedRejection).resolves.toMatchObject({
        message: `Llm host request ${requestId} was aborted.`,
      });
      expect(manager.requests.size()).toBe(0);
      expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'cancel', requestId }),
        })
      );
    });

    it('cancels the exact manager request when the real local stream watchdog fires', async () => {
      const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
      const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
      process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '20';
      process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '1000';
      // The host stream opens and produces NOTHING, so this stall lands in the
      // `awaiting-output` phase and the first-output window governs it, not the
      // inter-output one (BST-1408).
      const previousFirstOutput = process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'];
      process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '1000';
      // This case is about the watchdog cancelling the EXACT host request and
      // the run terminating visibly, so it opts out of in-turn stall recovery
      // (BST-1409); with the default budget the turn would continue instead.
      // Recovery itself is pinned in the agent package's
      // mastra-stall-recovery.integration.spec.ts.
      const previousStallAttempts = process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'];
      process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '1';
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

      try {
        const iterator = await streamMastraAgent(
          [
            {
              id: 'watchdog-manager-user',
              parts: [{ text: 'stall in the hidden host', type: 'text' }],
              role: 'user',
            },
          ],
          {
            runtime: {
              localLlmHostClient: createMainLlmHostClient(manager),
              model: 'onnx-community/gemma-4-E2B-it-ONNX',
              provider: 'local',
            },
          }
        );
        const session = new AssistantDataStreamSession(iterator, () => {});
        const bodyPromise = drainResponse(session.createResponse());

        await vi.waitFor(() => {
          expect(manager.requests.size()).toBe(1);
        });
        const [stalledRequestId] = manager.requests.ids();
        expect(stalledRequestId).toMatch(/^main:/);

        await vi.advanceTimersByTimeAsync(1001);

        const body = await bodyPromise;
        // Phase-specific copy (BST-1408): the built-in local provider produced
        // NOTHING, so the message must not imply it had been streaming. The
        // durable metadata alongside it carries the full story —
        // `phase: 'awaiting-output'`, `partsSeen: 2`, `lastPartType: 'step-start'`.
        expect(body).toContain(
          'The model produced no output within 1000ms of the request starting.'
        );
        expect(body).toContain('"phase":"awaiting-output"');
        expect(body).toContain('"lastPartType":"step-start"');
        expect(body).toContain('stream_inactivity_timeout');
        expect(body).toContain('"finishReason":"error"');
        expect(session.isClosed()).toBe(true);
        expect(manager.getPlatformStatus()).toMatchObject({
          active: false,
          pendingRequestCount: 0,
        });
        expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            payload: expect.objectContaining({
              kind: 'cancel',
              requestId: stalledRequestId,
            }),
          })
        );

        // A late host result for the terminal request has no pending owner and
        // therefore cannot append to the already-closed UI stream.
        manager.acceptResponseReport(71, {
          channel: 'llm-result',
          payload: {
            result: {
              finishReason: 'stop',
              text: 'too late',
              usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
            },
          },
          requestId: stalledRequestId ?? 'missing',
          runtimeId: 'llm-host-runtime',
          type: 'result',
        });
        expect(manager.requests.size()).toBe(0);

        const recoveredIterator = await streamMastraAgent(
          [
            {
              id: 'watchdog-manager-retry',
              parts: [{ text: 'retry', type: 'text' }],
              role: 'user',
            },
          ],
          {
            runtime: {
              localLlmHostClient: createMainLlmHostClient(manager),
              model: 'onnx-community/gemma-4-E2B-it-ONNX',
              provider: 'local',
            },
          }
        );
        const recoveredSession = new AssistantDataStreamSession(recoveredIterator, () => {});
        const recoveredBodyPromise = drainResponse(recoveredSession.createResponse());

        await vi.waitFor(() => {
          expect(manager.requests.size()).toBe(1);
        });
        const [recoveredRequestId] = manager.requests.ids();
        expect(recoveredRequestId).not.toBe(stalledRequestId);
        manager.acceptResponseReport(71, {
          channel: 'llm-progress',
          payload: { kind: 'text', text: 'recovered' },
          requestId: recoveredRequestId ?? 'missing',
          runtimeId: 'llm-host-runtime',
          type: 'progress',
        });
        manager.acceptResponseReport(71, {
          channel: 'llm-result',
          payload: {
            result: {
              finishReason: 'stop',
              text: 'recovered',
              usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
            },
          },
          requestId: recoveredRequestId ?? 'missing',
          runtimeId: 'llm-host-runtime',
          type: 'result',
        });

        await expect(recoveredBodyPromise).resolves.toContain('recovered');
        expect(manager.requests.size()).toBe(0);
      } finally {
        if (previousFirstOutput === undefined) {
          Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS');
        } else {
          process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = previousFirstOutput;
        }
        if (previousStallAttempts === undefined) {
          Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_STALL_ATTEMPTS');
        } else {
          process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = previousStallAttempts;
        }
        if (previousToolTimeout === undefined) {
          Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
        } else {
          process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
        }
        if (previousStreamInactivity === undefined) {
          Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
        } else {
          process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
        }
      }
    });

    it('generateForMain throws immediately when the signal is already aborted', async () => {
      const manager = new LlmHostManager();
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        manager.generateForMain(
          {
            messages: [{ content: 'hi', role: 'user' }],
            modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          },
          { signal: abortController.signal }
        )
      ).rejects.toThrow('Llm host request was aborted before dispatch.');
      expect(mockHostWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('generateForMain rejects a null result payload instead of returning it', async () => {
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

      const requestPromise = manager.generateForMain({
        messages: [{ content: 'hi', role: 'user' }],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      });
      const observedRejection = requestPromise.then(
        () => null,
        (error: unknown) => error
      );

      await vi.waitFor(() => {
        expect(manager.requests.size()).toBe(1);
      });
      const [requestId] = manager.requests.ids();

      manager.acceptResponseReport(71, {
        channel: 'llm-result',
        payload: { result: null },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'result',
      });

      await expect(observedRejection).resolves.toMatchObject({
        message: expect.stringContaining('returned no result payload'),
      });
    });

    it('broadcasts main-initiated loading progress to visible windows so the UI shows downloads', async () => {
      // Cold MEMORY-model warmups are triggered by the assistant server (main
      // process) with no renderer request in flight; without this broadcast
      // the user stares at a silent spinner while gigabytes download. The
      // windows carry the roles createWindow and the host lifecycles assign.
      assignWindowRole(mockVisibleWindow as unknown as BrowserWindow, 'visible-ui');
      assignWindowRole(mockHiddenHostWindow as unknown as BrowserWindow, 'llm-host');
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');
      await vi.waitFor(() => {
        expect(manager.requests.size()).toBe(1);
      });
      const [requestId] = manager.requests.ids();

      manager.acceptResponseReport(71, {
        channel: 'llm-progress',
        payload: {
          file: 'model.onnx',
          kind: 'loading',
          message: 'Downloading model',
          progress: 42,
        },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'progress',
      });

      expect(mockVisibleWindow.webContents.send).toHaveBeenCalledWith(
        expect.stringContaining('progress'),
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'loading', progress: 42 }),
          type: 'progress',
        })
      );

      manager.acceptResponseReport(71, {
        channel: 'llm-result',
        payload: { result: null },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'result',
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
      expect(mockHiddenHostWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('does not broadcast renderer-initiated progress a second time', async () => {
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;
      const requester = createRequester(101);

      const requestPromise = manager.generate(requester, {
        clientRequestId: 'req-renderer-progress',
        kind: 'generate',
        messages: [],
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        options: {},
      });

      await vi.waitFor(() => {
        expect(manager.requests.size()).toBe(1);
      });
      manager.acceptResponseReport(71, {
        channel: 'llm-progress',
        payload: { kind: 'loading', progress: 10 },
        requestId: '101:req-renderer-progress',
        runtimeId: 'llm-host-runtime',
        type: 'progress',
      });

      // Renderer callers already receive progress over their own IPC channel.
      expect(mockVisibleWindow.webContents.send).not.toHaveBeenCalled();

      manager.acceptResponseReport(71, {
        channel: 'llm-result',
        payload: { result: { text: 'done' } },
        requestId: '101:req-renderer-progress',
        runtimeId: 'llm-host-runtime',
        type: 'result',
      });
      await expect(requestPromise).resolves.toEqual({ text: 'done' });
    });

    it('warmupForMain resolves when the host acknowledges with a null result', async () => {
      const manager = new LlmHostManager() as unknown as TestableLlmHostManager;

      const warmupPromise = manager.warmupForMain('onnx-community/gemma-4-E2B-it-ONNX');

      await vi.waitFor(() => {
        expect(manager.requests.size()).toBe(1);
      });
      const [requestId] = manager.requests.ids();
      expect(requestId?.startsWith('main:')).toBe(true);

      manager.acceptResponseReport(71, {
        channel: 'llm-result',
        payload: { result: null },
        requestId: requestId ?? 'missing',
        runtimeId: 'llm-host-runtime',
        type: 'result',
      });

      await expect(warmupPromise).resolves.toBeUndefined();
    });
  });
});
