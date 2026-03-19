import { describe, expect, it, vi } from 'vitest';
import {
  BackfillMaintenanceCoordinator,
  type GpuMemoryReclaimConfig,
} from '../backfill-maintenance-coordinator';

function createCoordinator(
  config: GpuMemoryReclaimConfig,
  overrides?: Partial<{
    destroyAndRestart: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>
): {
  coordinator: BackfillMaintenanceCoordinator;
  hostManager: {
    destroyAndRestart: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
} {
  const hostManager = {
    reset:
      overrides?.reset ??
      vi.fn(async () => ({
        state: 'running' as const,
        lastError: null,
        active: false,
        runtimeId: 'embedding-host-runtime',
      })),
    stop:
      overrides?.stop ??
      vi.fn(async () => ({
        state: 'stopped' as const,
        lastError: null,
        active: false,
        runtimeId: 'embedding-host-runtime',
      })),
    destroyAndRestart:
      overrides?.destroyAndRestart ??
      vi.fn(async () => ({
        state: 'running' as const,
        lastError: null,
        active: false,
        runtimeId: 'embedding-host-runtime',
      })),
  };

  return {
    coordinator: new BackfillMaintenanceCoordinator(config, 'set-123', hostManager),
    hostManager,
  };
}

describe('BackfillMaintenanceCoordinator', () => {
  it('requests maintenance only after the completed-item threshold is crossed', async () => {
    const { coordinator, hostManager } = createCoordinator({
      enabled: true,
      itemThreshold: 3,
      minimumIntervalMs: 0,
      mode: 'reset',
    });

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();
    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).not.toHaveBeenCalled();
    expect(coordinator.getState()).toBe('idle');

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getReclaimCycleCount()).toBe(1);
    expect(coordinator.getState()).toBe('idle');
  });

  it('treats host stop as planned while maintenance is running', async () => {
    let resolveReset: (() => void) | null = null;
    const { coordinator } = createCoordinator(
      {
        enabled: true,
        itemThreshold: 1,
        minimumIntervalMs: 0,
        mode: 'reset',
      },
      {
        reset: vi.fn(
          async () =>
            await new Promise((resolve) => {
              resolveReset = () =>
                resolve({
                  state: 'running' as const,
                  lastError: null,
                  active: false,
                  runtimeId: 'embedding-host-runtime',
                });
            })
        ),
      }
    );

    coordinator.noteCompletedItems(1);
    const maintenancePromise = coordinator.runRequestedMaintenance();

    expect(() =>
      coordinator.assertCanContinue({
        state: 'stopped',
        lastError: null,
      })
    ).not.toThrow();

    resolveReset?.();
    await maintenancePromise;
  });

  it('fails fast on unexpected host stop when no maintenance is planned', () => {
    const { coordinator } = createCoordinator({
      enabled: true,
      itemThreshold: 2,
      minimumIntervalMs: 0,
      mode: 'reset',
    });

    expect(() =>
      coordinator.assertCanContinue({
        state: 'stopped',
        lastError: null,
      })
    ).toThrow('Embedding host stopped while backfill was in progress.');
  });

  it('surfaces maintenance failures and keeps failing after the first failure', async () => {
    const { coordinator } = createCoordinator(
      {
        enabled: true,
        itemThreshold: 1,
        minimumIntervalMs: 0,
        mode: 'reset',
      },
      {
        reset: vi.fn(async () => ({
          state: 'error' as const,
          lastError: 'reset failed',
          active: false,
          runtimeId: 'embedding-host-runtime',
        })),
      }
    );

    coordinator.noteCompletedItems(1);

    await expect(coordinator.runRequestedMaintenance()).rejects.toThrow(
      'Embedding host GPU reclaim maintenance failed: reset failed'
    );
    expect(coordinator.getState()).toBe('failed');
    expect(() =>
      coordinator.assertCanContinue({
        state: 'running',
        lastError: null,
      })
    ).toThrow('Embedding host GPU reclaim maintenance failed: reset failed');
  });

  it('uses recreate-window mode by stopping before destroyAndRestart', async () => {
    const { coordinator, hostManager } = createCoordinator({
      enabled: true,
      itemThreshold: 1,
      minimumIntervalMs: 0,
      mode: 'recreate-window',
    });

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.stop).toHaveBeenCalledTimes(1);
    expect(hostManager.destroyAndRestart).toHaveBeenCalledTimes(1);
    expect(hostManager.reset).not.toHaveBeenCalled();
  });

  it('keeps maintenance requested until the minimum interval has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
    const { coordinator, hostManager } = createCoordinator({
      enabled: true,
      itemThreshold: 1,
      minimumIntervalMs: 15_000,
      mode: 'reset',
    });

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toBe('idle');

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toBe('requested');

    vi.advanceTimersByTime(15_000);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toBe('idle');
    vi.useRealTimers();
  });
});
