import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from '../register-background-runtime-lifecycle-ipc';

// The global setup provides ipcMain with handle/on as vi.fn(), but not
// removeHandler/removeListener. Add them for cleanup to work.
const mockIpcMain = ipcMain as unknown as {
  handle: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeHandler: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

const CHANNELS = {
  ensureStarted: 'test:ensureStarted',
  getStatus: 'test:getStatus',
  reportStatus: 'test:reportStatus',
  reset: 'test:reset',
  stop: 'test:stop',
} as const;

function createMockManager() {
  return {
    acceptStatusReport: vi.fn(),
    ensureStarted: vi.fn().mockResolvedValue({ state: 'running' }),
    getStatus: vi.fn().mockReturnValue({ state: 'idle' }),
    reset: vi.fn().mockResolvedValue({ state: 'idle' }),
    stop: vi.fn().mockResolvedValue({ state: 'stopped' }),
  };
}

function createMockAssertStatus() {
  return vi.fn((value: unknown) => value as { state: string });
}

describe('registerBackgroundRuntimeLifecycleIpcHandlers', () => {
  let cleanup: () => void;

  beforeEach(() => {
    // Ensure ipcMain has all methods needed
    if (!mockIpcMain.removeHandler) {
      mockIpcMain.removeHandler = vi.fn();
    }
    if (!mockIpcMain.removeListener) {
      mockIpcMain.removeListener = vi.fn();
    }
  });

  afterEach(() => {
    cleanup?.();
    vi.clearAllMocks();
  });

  it('registers all 4 handle channels and 1 on listener', () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const handleChannels = (mockIpcMain.handle.mock.calls as [string, unknown][]).map(([ch]) => ch);
    expect(handleChannels).toContain(CHANNELS.ensureStarted);
    expect(handleChannels).toContain(CHANNELS.stop);
    expect(handleChannels).toContain(CHANNELS.reset);
    expect(handleChannels).toContain(CHANNELS.getStatus);

    const onChannels = (mockIpcMain.on.mock.calls as [string, unknown][]).map(([ch]) => ch);
    expect(onChannels).toContain(CHANNELS.reportStatus);
  });

  it('ensureStarted handler delegates with waitForRunning: true', async () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const handler = (
      mockIpcMain.handle.mock.calls as [string, (...args: unknown[]) => unknown][]
    ).find(([ch]) => ch === CHANNELS.ensureStarted)?.[1];
    expect(handler).toBeDefined();

    const result = await handler!();
    expect(manager.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
    expect(result).toEqual({ state: 'running' });
  });

  it('stop handler delegates to manager.stop()', async () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const handler = (
      mockIpcMain.handle.mock.calls as [string, (...args: unknown[]) => unknown][]
    ).find(([ch]) => ch === CHANNELS.stop)?.[1];

    const result = await handler!();
    expect(manager.stop).toHaveBeenCalled();
    expect(result).toEqual({ state: 'stopped' });
  });

  it('reset handler delegates to manager.reset()', async () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const handler = (
      mockIpcMain.handle.mock.calls as [string, (...args: unknown[]) => unknown][]
    ).find(([ch]) => ch === CHANNELS.reset)?.[1];

    const result = await handler!();
    expect(manager.reset).toHaveBeenCalled();
    expect(result).toEqual({ state: 'idle' });
  });

  it('getStatus handler delegates to manager.getStatus()', async () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const handler = (
      mockIpcMain.handle.mock.calls as [string, (...args: unknown[]) => unknown][]
    ).find(([ch]) => ch === CHANNELS.getStatus)?.[1];

    const result = await handler!();
    expect(manager.getStatus).toHaveBeenCalled();
    expect(result).toEqual({ state: 'idle' });
  });

  it('reportStatus listener validates payload and calls acceptStatusReport', () => {
    const manager = createMockManager();
    const assertStatus = createMockAssertStatus();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus,
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const listener = (mockIpcMain.on.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ch]) => ch === CHANNELS.reportStatus
    )?.[1];
    expect(listener).toBeDefined();

    const mockEvent = { sender: { id: 42 } };
    const payload = { state: 'running' };
    listener!(mockEvent, payload);

    expect(assertStatus).toHaveBeenCalledWith(payload);
    expect(manager.acceptStatusReport).toHaveBeenCalledWith(42, payload);
  });

  it('reportStatus listener propagates assertStatus errors', () => {
    const manager = createMockManager();
    const assertStatus = vi.fn(() => {
      throw new Error('invalid status');
    });
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus,
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    const listener = (mockIpcMain.on.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ch]) => ch === CHANNELS.reportStatus
    )?.[1];

    const mockEvent = { sender: { id: 1 } };
    expect(() => listener!(mockEvent, 'bad')).toThrow('invalid status');
    expect(manager.acceptStatusReport).not.toHaveBeenCalled();
  });

  it('cleanup removes all handlers and listeners', () => {
    const manager = createMockManager();
    cleanup = registerBackgroundRuntimeLifecycleIpcHandlers({
      assertStatus: createMockAssertStatus(),
      channels: CHANNELS,
      domain: 'runtime',
      manager,
    });

    cleanup();

    const removedHandlers = (mockIpcMain.removeHandler.mock.calls as [string][]).map(([ch]) => ch);
    expect(removedHandlers).toContain(CHANNELS.ensureStarted);
    expect(removedHandlers).toContain(CHANNELS.stop);
    expect(removedHandlers).toContain(CHANNELS.reset);
    expect(removedHandlers).toContain(CHANNELS.getStatus);

    expect(mockIpcMain.removeListener).toHaveBeenCalledWith(
      CHANNELS.reportStatus,
      expect.any(Function)
    );
  });
});
