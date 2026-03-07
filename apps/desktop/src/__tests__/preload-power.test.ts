import Module from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOP_CHANNEL,
} from '../embedding-host-shared';

// CJS require('electron') in preload.ts resolves via Node's native module loader,
// which returns the Electron binary path (a string), not the API object.
// vi.mock only intercepts ESM import(), so we must patch Module._load for CJS.
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn();
const mockSend = vi.fn();

const mockElectron = {
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend,
  },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
};

const originalLoad = Module._load;
// @ts-expect-error -- Module._load signature is internal
Module._load = function (id: string, ...rest: unknown[]) {
  if (id === 'electron') {
    return mockElectron;
  }
  // @ts-expect-error -- forwarding to original
  return originalLoad.call(this, id, ...rest);
};

afterAll(() => {
  Module._load = originalLoad;
});

describe('preload power bridge', () => {
  beforeAll(async () => {
    await import('../preload');
  });

  function getPowerApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'power');
    return call?.[1] as { onPowerState: (cb: (state: string) => void) => () => void } | undefined;
  }

  function getEmbeddingHostApi() {
    const call = mockExposeInMainWorld.mock.calls.find(
      ([key]: [string]) => key === 'embeddingHost'
    );
    return call?.[1] as
      | {
          ensureStarted: () => Promise<unknown>;
          stop: () => Promise<unknown>;
          reset: () => Promise<unknown>;
          getStatus: () => Promise<unknown>;
          reportStatus: (status: unknown) => void;
          onStatus: (cb: (status: unknown) => void) => () => void;
          onCommand: (cb: (command: unknown) => void) => () => void;
        }
      | undefined;
  }

  it('exposes power.onPowerState via contextBridge', () => {
    const powerApi = getPowerApi();
    expect(powerApi).toBeDefined();
    expect(typeof powerApi?.onPowerState).toBe('function');
  });

  it('subscribes to app:power-state IPC channel', () => {
    mockOn.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    powerApi?.onPowerState(cb);
    expect(mockOn).toHaveBeenCalledWith('app:power-state', expect.any(Function));
  });

  it('forwards power state string to callback', () => {
    mockOn.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    powerApi?.onPowerState(cb);

    const ipcListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === 'app:power-state'
    )?.[1] as (event: unknown, state: string) => void;

    ipcListener(null, 'suspend');
    expect(cb).toHaveBeenCalledWith('suspend');

    ipcListener(null, 'resume');
    expect(cb).toHaveBeenCalledWith('resume');
  });

  it('cleanup function removes the IPC listener', () => {
    mockRemoveListener.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    const cleanup = powerApi?.onPowerState(cb);

    cleanup?.();
    expect(mockRemoveListener).toHaveBeenCalledWith('app:power-state', expect.any(Function));
  });

  it('exposes the embeddingHost lifecycle bridge', async () => {
    mockInvoke.mockResolvedValue({ state: 'running', active: false, lastError: null });
    const embeddingHostApi = getEmbeddingHostApi();
    expect(embeddingHostApi).toBeDefined();

    await embeddingHostApi?.ensureStarted();
    await embeddingHostApi?.stop();
    await embeddingHostApi?.reset();
    await embeddingHostApi?.getStatus();

    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_STOP_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_RESET_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_GET_STATUS_CHANNEL);
  });

  it('forwards embedding host reports and subscribes to host events', () => {
    mockOn.mockClear();
    mockSend.mockClear();
    mockRemoveListener.mockClear();

    const embeddingHostApi = getEmbeddingHostApi();
    const statusCallback = vi.fn();
    const commandCallback = vi.fn();

    embeddingHostApi?.reportStatus({ state: 'running', active: true, lastError: null });
    const cleanupStatus = embeddingHostApi?.onStatus(statusCallback);
    const cleanupCommand = embeddingHostApi?.onCommand(commandCallback);

    expect(mockSend).toHaveBeenCalledWith(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, {
      state: 'running',
      active: true,
      lastError: null,
    });
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_COMMAND_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === EMBEDDING_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, status: unknown) => void;
    const commandListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === EMBEDDING_HOST_COMMAND_EVENT
    )?.[1] as (event: unknown, command: unknown) => void;

    statusListener(null, { state: 'running', active: false, lastError: null });
    commandListener(null, { type: 'reset' });

    expect(statusCallback).toHaveBeenCalledWith({
      state: 'running',
      active: false,
      lastError: null,
    });
    expect(commandCallback).toHaveBeenCalledWith({ type: 'reset' });

    cleanupStatus?.();
    cleanupCommand?.();

    expect(mockRemoveListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_STATUS_EVENT,
      expect.any(Function)
    );
    expect(mockRemoveListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_COMMAND_EVENT,
      expect.any(Function)
    );
  });
});
