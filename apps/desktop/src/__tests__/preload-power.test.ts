import Module from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// CJS require('electron') in preload.ts resolves via Node's native module loader,
// which returns the Electron binary path (a string), not the API object.
// vi.mock only intercepts ESM import(), so we must patch Module._load for CJS.
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn();

const mockElectron = {
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
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
});
