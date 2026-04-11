import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcMainHandle = vi.fn();
const ipcMainOn = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMainHandle,
    on: ipcMainOn,
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../register-background-runtime-lifecycle-ipc', () => ({
  registerBackgroundRuntimeLifecycleIpcHandlers: vi.fn(() => vi.fn()),
}));

describe('ipc-llm-host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates generate payloads before forwarding them to the manager', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn().mockResolvedValue({ text: 'ok' }),
      warmup: vi.fn(),
      warmupRequest: vi.fn(),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const generateCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:generate'
    );
    if (!generateCall) {
      throw new Error('llm-host:generate handler not registered');
    }

    const generateHandler = generateCall[1] as (
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>;
    await expect(
      generateHandler({ sender: {} } as IpcMainInvokeEvent, {
        kind: 'generate',
        clientRequestId: 'req-1',
        modelId: '',
        messages: [],
      })
    ).rejects.toThrow('Llm host generate payload.modelId must be a non-empty string.');
    expect(manager.generate).not.toHaveBeenCalled();
  });

  it('rejects malformed llm-host generate messages before dispatching to the manager', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn().mockResolvedValue({ text: 'ok' }),
      warmup: vi.fn(),
      warmupRequest: vi.fn(),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const generateCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:generate'
    );
    if (!generateCall) {
      throw new Error('llm-host:generate handler not registered');
    }

    const generateHandler = generateCall[1] as (
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>;
    await expect(
      generateHandler({ sender: {} } as IpcMainInvokeEvent, {
        kind: 'generate',
        clientRequestId: 'req-1',
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        messages: [{ role: 'user', content: null }],
      })
    ).rejects.toThrow('Llm host generate payload.messages[0].content must be a non-empty string.');
    expect(manager.generate).not.toHaveBeenCalled();
  });

  it('validates warmup payloads before forwarding them to the manager', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn(),
      warmup: vi.fn(),
      warmupRequest: vi.fn().mockResolvedValue(undefined),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const warmupCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:warmup'
    );
    if (!warmupCall) {
      throw new Error('llm-host:warmup handler not registered');
    }

    const warmupHandler = warmupCall[1] as (
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>;
    await expect(
      warmupHandler({ sender: {} } as IpcMainInvokeEvent, {
        clientRequestId: '  ',
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      })
    ).rejects.toThrow('Llm host warmup payload.clientRequestId must be a non-empty string.');
    expect(manager.warmupRequest).not.toHaveBeenCalled();
  });

  it('requires warmup payloads to include a client request id', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn(),
      warmup: vi.fn(),
      warmupRequest: vi.fn().mockResolvedValue(undefined),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const warmupCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:warmup'
    );
    if (!warmupCall) {
      throw new Error('llm-host:warmup handler not registered');
    }

    const warmupHandler = warmupCall[1] as (
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>;
    await expect(
      warmupHandler({ sender: {} } as IpcMainInvokeEvent, {
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      })
    ).rejects.toThrow('Llm host warmup payload.clientRequestId must be a non-empty string.');
    expect(manager.warmupRequest).not.toHaveBeenCalled();
  });

  it('normalizes legacy string warmup payloads through the shared validator', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn(),
      warmup: vi.fn(),
      warmupRequest: vi.fn().mockResolvedValue(undefined),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const warmupCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:warmup'
    );
    if (!warmupCall) {
      throw new Error('llm-host:warmup handler not registered');
    }

    const warmupHandler = warmupCall[1] as (
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>;
    await warmupHandler(
      { sender: { id: 1 } } as unknown as IpcMainInvokeEvent,
      'onnx-community/gemma-4-E2B-it-ONNX'
    );

    expect(manager.warmupRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'warmup',
        modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      })
    );
  });

  it('validates host response reports before forwarding them to the manager', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      generate: vi.fn(),
      warmup: vi.fn(),
      warmupRequest: vi.fn(),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const responseCall = ipcMainOn.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:report-response'
    );
    if (!responseCall) {
      throw new Error('llm-host:report-response listener not registered');
    }

    const responseListener = responseCall[1] as (
      event: { sender: { id: number } },
      payload: unknown
    ) => void;

    expect(() =>
      responseListener(
        { sender: { id: 1 } },
        {
          type: 'result',
          requestId: '',
          runtimeId: 'runtime',
          payload: { result: null },
        }
      )
    ).toThrow('Llm host response report.requestId must be a non-empty string.');
    expect(manager.acceptResponseReport).not.toHaveBeenCalled();
  });

  it('rejects non-string cancel request ids before forwarding them to the manager', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      cancel: vi.fn(),
      generate: vi.fn(),
      warmup: vi.fn(),
      warmupRequest: vi.fn(),
    };

    const { registerLlmHostIpcHandlers } = await import('../ipc-llm-host');
    registerLlmHostIpcHandlers(manager as never);

    const cancelCall = ipcMainHandle.mock.calls.find(
      ([channel]: readonly [string]) => channel === 'llm-host:cancel'
    );
    if (!cancelCall) {
      throw new Error('llm-host:cancel handler not registered');
    }

    const cancelHandler = cancelCall[1] as (
      event: IpcMainInvokeEvent,
      requestId: unknown
    ) => Promise<unknown>;

    await expect(
      cancelHandler({ sender: {} } as IpcMainInvokeEvent, { bad: true })
    ).rejects.toThrow('Llm host cancel requestId must be a string.');
    expect(manager.cancel).not.toHaveBeenCalled();
  });
});
