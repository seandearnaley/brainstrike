import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
