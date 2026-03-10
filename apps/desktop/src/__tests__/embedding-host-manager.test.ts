import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentLifecycleStatus, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 91,
      send: vi.fn(),
    },
  };
  const currentStatus = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
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
        runtimeId: 'embedding-host-runtime',
        state: 'running' as const,
      })),
      getHostWindow: vi.fn(() => hostWindow),
      getStatus: vi.fn(() => ({ ...currentStatus })),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn((status) => {
        currentStatus.active = status.active;
        currentStatus.lastError = status.lastError;
        currentStatus.runtimeId = status.runtimeId;
        currentStatus.state = status.state;
      }),
      waitForStatus: vi.fn(async () => ({
        active: false,
        lastError: 'boom',
        runtimeId: 'embedding-host-runtime',
        state: 'error' as const,
      })),
    },
    mockHostWindow: hostWindow,
  };
});

const { powerSaveBlockerIsStartedMock, powerSaveBlockerStartMock, powerSaveBlockerStopMock } =
  vi.hoisted(() => ({
    powerSaveBlockerStartMock: vi.fn(() => 101),
    powerSaveBlockerStopMock: vi.fn(),
    powerSaveBlockerIsStartedMock: vi.fn(() => true),
  }));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false,
  },
  powerSaveBlocker: {
    start: powerSaveBlockerStartMock,
    stop: powerSaveBlockerStopMock,
    isStarted: powerSaveBlockerIsStartedMock,
  },
}));

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';

type TestableEmbeddingHostManager = EmbeddingHostManager & {
  syncPowerSaveBlocker(status: {
    active: boolean;
    lastError: string | null;
    state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
  }): void;
};

describe('EmbeddingHostManager powerSaveBlocker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    currentLifecycleStatus.active = false;
    currentLifecycleStatus.lastError = null;
    currentLifecycleStatus.runtimeId = 'embedding-host-runtime';
    currentLifecycleStatus.state = 'running';
    lifecycleState.waitForStatus.mockResolvedValue({
      active: false,
      lastError: 'boom',
      runtimeId: 'embedding-host-runtime',
      state: 'error',
    });
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  it('keeps the blocker active across short idle gaps while the host remains running', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });

    vi.advanceTimersByTime(4000);

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('stops the blocker after sustained idle while the host remains running', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('stops the blocker immediately when the host leaves the running state', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'error', active: false, lastError: 'fatal' });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('does not stop the blocker from an idle timer after the manager is disposed', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager & {
      disposed: boolean;
    };

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });
    manager.disposed = true;

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('fails fast if ensureStarted is called after dispose', async () => {
    const manager = new EmbeddingHostManager();

    await manager.dispose();

    await expect(manager.ensureStarted()).rejects.toThrow(
      'EmbeddingHostManager.ensureStarted cannot be called after dispose().'
    );
  });

  it('captures the runtime id once and tears down on error status during stop', async () => {
    const manager = new EmbeddingHostManager();

    await manager.stop();

    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({
        runtimeId: 'embedding-host-runtime',
      })
    );
    expect(lifecycleState.waitForStatus).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(lifecycleState.destroyHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.clearHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenCalled();
  });

  it('debounces inactive status reports across short embedding idle gaps', () => {
    const manager = new EmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: false,
      lastError: null,
    });

    vi.advanceTimersByTime(4000);

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: true,
      lastError: null,
    });

    vi.advanceTimersByTime(1500);

    expect(lifecycleState.setStatus).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        state: 'running',
      })
    );
  });

  it('applies inactive status after sustained embedding idle', () => {
    const manager = new EmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: false,
      lastError: null,
    });

    vi.advanceTimersByTime(5001);

    expect(lifecycleState.setStatus).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        active: false,
        state: 'running',
      })
    );
  });
});
