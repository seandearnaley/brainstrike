import { describe, expect, it, vi } from 'vitest';
import {
  BackfillMaintenanceCoordinator,
  type GpuMemoryReclaimConfig,
} from '../backfill-maintenance-coordinator';

function createCoordinator(
  config: GpuMemoryReclaimConfig,
  overrides?: Partial<{
    now: () => number;
    reset: ReturnType<typeof vi.fn>;
  }>
): {
  coordinator: BackfillMaintenanceCoordinator;
  hostManager: {
    reset: ReturnType<typeof vi.fn>;
  };
} {
  const hostManager = {
    reset:
      overrides?.reset ??
      vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host-runtime',
        state: 'running' as const,
      })),
  };

  return {
    coordinator: new BackfillMaintenanceCoordinator(config, 'set-123', hostManager, overrides?.now),
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
                  active: false,
                  lastError: null,
                  runtimeId: 'embedding-host-runtime',
                  state: 'running' as const,
                });
            })
        ),
      }
    );

    coordinator.noteCompletedItems(1);
    const maintenancePromise = coordinator.runRequestedMaintenance();

    expect(() =>
      coordinator.assertCanContinue({
        lastError: null,
        state: 'stopped',
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
        lastError: null,
        state: 'stopped',
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
          active: false,
          lastError: 'reset failed',
          runtimeId: 'embedding-host-runtime',
          state: 'error' as const,
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
        lastError: null,
        state: 'running',
      })
    ).toThrow('Embedding host GPU reclaim maintenance failed: reset failed');
  });

  it('keeps maintenance requested until the minimum interval has elapsed', async () => {
    let now = 1;
    const { coordinator, hostManager } = createCoordinator(
      {
        enabled: true,
        itemThreshold: 1,
        minimumIntervalMs: 15_000,
        mode: 'reset',
      },
      {
        now: () => now,
      }
    );

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toBe('idle');

    coordinator.noteCompletedItems(1);
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toBe('requested');

    now += 15_000;
    await coordinator.runRequestedMaintenance();

    expect(hostManager.reset).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toBe('idle');
  });

  it('preserves the original error as the failure cause', async () => {
    const rootCause = new Error('reset exploded');
    const { coordinator } = createCoordinator(
      {
        enabled: true,
        itemThreshold: 1,
        minimumIntervalMs: 0,
        mode: 'reset',
      },
      {
        reset: vi.fn(async () => {
          throw rootCause;
        }),
      }
    );

    coordinator.noteCompletedItems(1);

    try {
      await coordinator.runRequestedMaintenance();
      throw new Error('Expected maintenance to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Embedding host GPU reclaim maintenance failed: reset exploded'
      );
      expect((error as Error).cause).toBe(rootCause);
    }
  });
});
