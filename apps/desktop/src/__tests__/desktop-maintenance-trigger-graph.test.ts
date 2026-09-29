import { Effect, type Scope } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopMaintenanceTriggerGraph,
  type MaintenanceTriggerAcquirer,
} from '../desktop-maintenance-trigger-graph';
import { acquireMaintenanceTriggerResources } from '../maintenance-trigger-runtime';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function trigger(
  acquire: (isLive: () => boolean) => Effect.Effect<void, never, Scope.Scope>
): MaintenanceTriggerAcquirer {
  return { acquireTrigger: acquire };
}

describe('desktop maintenance trigger graph', () => {
  it('shares one start when a synchronous subscriber reenters startup', async () => {
    let graph: ReturnType<typeof createDesktopMaintenanceTriggerGraph>;
    let reentrantStart: Promise<void> | undefined;
    const databaseAcquire = vi.fn();
    const database = trigger(() =>
      Effect.sync(() => {
        databaseAcquire();
        reentrantStart = graph.start();
      })
    );
    graph = createDesktopMaintenanceTriggerGraph(
      database,
      trigger(() => Effect.void)
    );

    const starting = graph.start();
    await starting;
    expect(reentrantStart).toBe(starting);
    expect(databaseAcquire).toHaveBeenCalledTimes(1);
    await graph.close();
  });

  it('joins a close reentered from subscription without acquiring the second trigger', async () => {
    let graph: ReturnType<typeof createDesktopMaintenanceTriggerGraph>;
    let reentrantClose: Promise<void> | undefined;
    const databaseRelease = vi.fn();
    const dimensionAcquire = vi.fn();
    const database = trigger(() =>
      Effect.acquireRelease(
        Effect.sync(() => {
          reentrantClose = graph.close();
        }),
        () => Effect.sync(databaseRelease)
      )
    );
    graph = createDesktopMaintenanceTriggerGraph(
      database,
      trigger(() => {
        dimensionAcquire();
        return Effect.void;
      })
    );

    await graph.start();
    await reentrantClose;
    expect(databaseRelease).toHaveBeenCalledTimes(1);
    expect(dimensionAcquire).not.toHaveBeenCalled();
    expect(graph.close()).toBe(reentrantClose);
  });

  it('fences and releases the first trigger when the second acquisition fails', async () => {
    const acquisitionError = new Error('dimension timer unavailable');
    const databaseRelease = vi.fn();
    let databaseLive: (() => boolean) | undefined;
    const database = trigger((isLive) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          databaseLive = isLive;
        }),
        () => Effect.sync(databaseRelease)
      )
    );
    const dimension = trigger(() => Effect.die(acquisitionError));
    const graph = createDesktopMaintenanceTriggerGraph(database, dimension);

    await expect(graph.start()).rejects.toBe(acquisitionError);
    expect(databaseLive?.()).toBe(false);
    expect(databaseRelease).toHaveBeenCalledTimes(1);
    await expect(graph.close()).rejects.toBe(acquisitionError);
  });

  it('rolls back real native timers and observers after the second timer fails', async () => {
    vi.useFakeTimers();
    const timerFailure = new Error('dimension timer failed');
    const nativeSetTimeout = globalThis.setTimeout;
    let timerAttempts = 0;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
      timerAttempts++;
      if (timerAttempts === 2) {
        throw timerFailure;
      }
      return nativeSetTimeout(...args);
    });
    const databaseRelease = vi.fn();
    const dimensionRelease = vi.fn();
    const databaseTick = vi.fn();
    const dimensionTick = vi.fn();
    const database = trigger((isLive) =>
      acquireMaintenanceTriggerResources(
        {
          initialDelayMs: 30,
          intervalMs: 100,
          onCloseError: vi.fn(),
          subscribe: () => databaseRelease,
          tick: databaseTick,
        },
        isLive
      )
    );
    const dimension = trigger((isLive) =>
      acquireMaintenanceTriggerResources(
        {
          initialDelayMs: 45,
          intervalMs: 100,
          onCloseError: vi.fn(),
          subscribe: () => dimensionRelease,
          tick: dimensionTick,
        },
        isLive
      )
    );
    const graph = createDesktopMaintenanceTriggerGraph(database, dimension);

    await expect(graph.start()).rejects.toBe(timerFailure);
    expect(databaseRelease).toHaveBeenCalledTimes(1);
    expect(dimensionRelease).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(databaseTick).not.toHaveBeenCalled();
    expect(dimensionTick).not.toHaveBeenCalled();
  });

  it('fences rollback before a slow first-trigger finalizer finishes', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let isDatabaseLive: (() => boolean) | undefined;
    const cleanupStarted = vi.fn();
    const database = trigger((isLive) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          isDatabaseLive = isLive;
        }),
        () =>
          Effect.promise(async () => {
            cleanupStarted();
            await cleanupGate;
          })
      )
    );
    const acquisitionError = new Error('dimension unavailable');
    const graph = createDesktopMaintenanceTriggerGraph(
      database,
      trigger(() => Effect.die(acquisitionError))
    );
    const starting = graph.start();

    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledTimes(1));
    expect(isDatabaseLive?.()).toBe(false);
    releaseCleanup?.();
    await expect(starting).rejects.toBe(acquisitionError);
  });

  it('retains acquisition and rollback failures in one error', async () => {
    const acquisitionError = new Error('dimension acquisition failed');
    const cleanupError = new Error('database unsubscribe failed');
    const graph = createDesktopMaintenanceTriggerGraph(
      trigger(() =>
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            throw cleanupError;
          })
        )
      ),
      trigger(() => Effect.die(acquisitionError))
    );

    const failure = await graph.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([acquisitionError, cleanupError]);
    await expect(graph.close()).rejects.toMatchObject({
      errors: [acquisitionError, cleanupError],
    });
  });

  it('attempts both child finalizers in parallel and retains both original errors', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const databaseError = new Error('database unsubscribe failed');
    const dimensionError = new Error('dimension unsubscribe failed');
    const databaseCleanup = vi.fn();
    const dimensionCleanup = vi.fn();
    const database = trigger(() =>
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          databaseCleanup();
          throw databaseError;
        })
      )
    );
    const dimension = trigger(() =>
      Effect.acquireRelease(Effect.void, () =>
        Effect.promise(async () => {
          dimensionCleanup();
          await cleanupGate;
          throw dimensionError;
        })
      )
    );
    const graph = createDesktopMaintenanceTriggerGraph(database, dimension);
    await graph.start();

    const closing = graph.close();
    expect(graph.close()).toBe(closing);
    await vi.waitFor(() => {
      expect(databaseCleanup).toHaveBeenCalledTimes(1);
      expect(dimensionCleanup).toHaveBeenCalledTimes(1);
    });
    releaseCleanup?.();
    const failure = await closing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([dimensionError, databaseError]);
    expect(graph.close()).toBe(closing);
  });

  it('retains an undefined finalizer failure instead of treating it as success', async () => {
    const graph = createDesktopMaintenanceTriggerGraph(
      trigger(() => Effect.acquireRelease(Effect.void, () => Effect.die(undefined))),
      trigger(() => Effect.void)
    );
    await graph.start();
    const closing = graph.close();
    await expect(closing).rejects.toBeUndefined();
    expect(graph.close()).toBe(closing);
  });

  it('joins an in-flight acquisition before close resolves and skips the second trigger', async () => {
    let markAcquisitionStarted: (() => void) | undefined;
    const acquisitionStarted = new Promise<void>((resolve) => {
      markAcquisitionStarted = resolve;
    });
    let releaseAcquisition: (() => void) | undefined;
    const acquisitionGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    const databaseRelease = vi.fn();
    const dimensionAcquire = vi.fn();
    const database = trigger((isLive) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => markAcquisitionStarted?.());
        yield* Effect.promise(() => acquisitionGate);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            expect(isLive()).toBe(false);
          }),
          () => Effect.sync(databaseRelease)
        );
      })
    );
    const dimension = trigger(() => {
      dimensionAcquire();
      return Effect.void;
    });
    const graph = createDesktopMaintenanceTriggerGraph(database, dimension);
    const starting = graph.start();
    await acquisitionStarted;
    const closing = graph.close();
    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseAcquisition?.();
    await Promise.all([starting, closing]);
    expect(databaseRelease).toHaveBeenCalledTimes(1);
    expect(dimensionAcquire).not.toHaveBeenCalled();
  });

  it('never acquires after close wins before first start', async () => {
    const databaseAcquire = vi.fn();
    const dimensionAcquire = vi.fn();
    const graph = createDesktopMaintenanceTriggerGraph(
      trigger(() => {
        databaseAcquire();
        return Effect.void;
      }),
      trigger(() => {
        dimensionAcquire();
        return Effect.void;
      })
    );

    const closing = graph.close();
    expect(graph.close()).toBe(closing);
    await closing;
    await graph.start();
    expect(databaseAcquire).not.toHaveBeenCalled();
    expect(dimensionAcquire).not.toHaveBeenCalled();
  });
});
