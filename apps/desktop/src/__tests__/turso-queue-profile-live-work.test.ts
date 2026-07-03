import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resetDesktopDatabaseWorkSchedulerForTests,
  runDesktopScheduledDatabaseWork,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from '../platform/desktop-database-work';
import { createTursoQueueProfileDiagnostics } from '../turso-queue-profile-diagnostics';

describe('Turso queue profile diagnostics with live owner and scheduler work', () => {
  let client: TursoOwnerClient | null = null;
  let now = 1000;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-queue-profile-'));
    now = 1000;
    resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 0, now: () => now });
    client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'profile.db'),
      now: () => now,
      slowQueueThresholdMs: 1000,
    });
  });

  afterEach(async () => {
    await waitForDesktopDatabaseWorkSchedulerIdle(1000).catch(() => undefined);
    await client?.close();
    client = null;
    resetDesktopDatabaseWorkSchedulerForTests();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('accepts live Turso owner topology after foreground and background SQL work are observed', async () => {
    const turso = requireClient(client);

    await runDesktopScheduledDatabaseWork(
      { label: 'turso.embedding-worker.queue.claimMany', priority: 'background' },
      async () =>
        turso.query<{ value: number }>('SELECT 1 AS value', [], {
          label: 'turso.embedding-worker.queue.claimMany',
          priority: 'background',
        })
    );

    now = 1025;
    await runDesktopScheduledDatabaseWork(
      { label: 'assistant foreground query', priority: 'foreground' },
      async () =>
        turso.query<{ value: number }>('SELECT 2 AS value', [], {
          label: 'assistant foreground query',
          priority: 'foreground',
        })
    );

    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: databaseDiagnosticsFromOwner(turso),
      scheduler: getDesktopDatabaseWorkSchedulerSnapshot(),
    });

    expect(diagnostics).toMatchObject({
      foregroundWaitP95Ms: 0,
      observedBackgroundWork: true,
      observedForegroundWork: true,
      reason: 'within-thresholds',
      status: 'accepted',
    });
  });

  it('blocks when foreground SQL waits behind active background scheduler work past the Turso threshold', async () => {
    const turso = requireClient(client);
    const backgroundGate = createDeferred<void>();
    const backgroundStarted = createDeferred<void>();

    const backgroundWork = runDesktopScheduledDatabaseWork(
      { label: 'turso.embedding-worker.queue.completeBatch', priority: 'background' },
      async () =>
        turso.transaction(
          async (tx) => {
            backgroundStarted.resolve();
            await tx.query('SELECT 1 AS value');
            await backgroundGate.promise;
          },
          {
            label: 'turso.embedding-worker.queue.completeBatch',
            priority: 'background',
          }
        )
    );

    await backgroundStarted.promise;
    now = 1100;

    const foregroundWork = runDesktopScheduledDatabaseWork(
      { label: 'assistant foreground query', priority: 'foreground' },
      async () =>
        turso.query<{ value: number }>('SELECT 2 AS value', [], {
          label: 'assistant foreground query',
          priority: 'foreground',
        })
    );

    await waitFor(() => getDesktopDatabaseWorkSchedulerSnapshot().queued.foreground === 1);
    now = 2200;
    backgroundGate.resolve();

    await backgroundWork;
    await foregroundWork;

    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: databaseDiagnosticsFromOwner(turso),
      scheduler: getDesktopDatabaseWorkSchedulerSnapshot(),
    });

    expect(diagnostics).toMatchObject({
      foregroundWaitP95Ms: 1100,
      foregroundWorstWaitMs: 1100,
      observedBackgroundWork: true,
      observedForegroundWork: true,
      reason: 'foreground-scheduler-wait-threshold-exceeded',
      status: 'blocked',
    });
  });
});

function databaseDiagnosticsFromOwner(client: TursoOwnerClient): unknown {
  return {
    profileBootstrapReport: {
      runtime: { engine: 'turso' },
    },
    tursoOwnerClientQoS: {
      available: true,
      ...client.getQoSDiagnostics(),
    },
  };
}

function requireClient(client: TursoOwnerClient | null): TursoOwnerClient {
  if (!client) {
    throw new Error('Turso test client was not initialized.');
  }
  return client;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}
