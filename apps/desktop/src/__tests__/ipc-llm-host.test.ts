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
        modelId: '',
        messages: [],
      })
    ).rejects.toThrow('Llm host generate payload.modelId must be a non-empty string.');
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
    ).rejects.toThrow('Llm host payload.clientRequestId must be a non-empty string.');
    expect(manager.warmupRequest).not.toHaveBeenCalled();
  });
});
