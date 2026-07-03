import type { DatabaseWorkSchedulerSnapshot } from '@brainstrike/db';
import type { DatabaseTursoOwnerClientQoSDiagnostics } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { createTursoQueueProfileDiagnostics } from '../turso-queue-profile-diagnostics';

function priorityStats(
  overrides: Partial<DatabaseWorkSchedulerSnapshot['priorityStats']['foreground']> = {}
) {
  return {
    completed: 0,
    lastCompletedLabel: null,
    lastStartedLabel: null,
    longestWaitMs: 0,
    queued: 0,
    serviceP50Ms: 0,
    serviceP95Ms: 0,
    started: 0,
    totalServiceMs: 0,
    totalWaitMs: 0,
    waitP50Ms: 0,
    waitP95Ms: 0,
    ...overrides,
  };
}

function schedulerSnapshot(
  overrides: Partial<DatabaseWorkSchedulerSnapshot> = {}
): DatabaseWorkSchedulerSnapshot {
  return {
    backgroundWaiting: false,
    backgroundWaitingSince: null,
    backgroundYieldCount: 0,
    currentBackgroundWaitMs: 0,
    foregroundQuietMs: 75,
    lastBackgroundYieldAt: null,
    lastCompletedAt: null,
    lastForegroundAt: null,
    lastNormalAt: null,
    lastStartedAt: null,
    priorityStats: {
      background: priorityStats(),
      foreground: priorityStats(),
      normal: priorityStats(),
    },
    queued: { background: 0, foreground: 0, normal: 0 },
    queuedLabels: { background: [], foreground: [], normal: [] },
    recentCompletedOperations: [],
    runningLabel: null,
    runningPriority: null,
    snapshotAt: 10_000,
    ...overrides,
  };
}

function schedulerSnapshotWithRecentCompleted(
  overrides: Partial<DatabaseWorkSchedulerSnapshot>,
  recentCompletedOperations: readonly {
    readonly completedAt: number;
    readonly enqueuedAt: number;
    readonly label: string | null;
    readonly priority: 'background' | 'foreground' | 'normal';
    readonly serviceMs: number;
    readonly startedAt: number;
    readonly waitMs: number;
  }[]
): DatabaseWorkSchedulerSnapshot {
  return Object.assign(schedulerSnapshot(overrides), {
    recentCompletedOperations,
  }) as DatabaseWorkSchedulerSnapshot;
}

function ownerQoS(
  overrides: Partial<Extract<DatabaseTursoOwnerClientQoSDiagnostics, { available: true }>> = {}
): DatabaseTursoOwnerClientQoSDiagnostics {
  return {
    activeOperation: null,
    available: true,
    queuedOperationCount: 0,
    queuedOperations: [],
    recentCompletedOperations: [
      {
        completedAt: 950,
        durationMs: 10,
        id: 101,
        kind: 'transaction',
        label: 'turso.embedding-worker.queue.complete',
        priority: 'background',
        queuedAt: 930,
        queueWaitMs: 10,
        startedAt: 940,
      },
      {
        completedAt: 980,
        durationMs: 10,
        id: 102,
        kind: 'query',
        label: 'assistant foreground query',
        priority: 'foreground',
        queuedAt: 960,
        queueWaitMs: 10,
        startedAt: 970,
      },
    ],
    slowQueuedOperationCount: 0,
    slowQueueThresholdMs: 1000,
    totalCompletedOperations: 4,
    totalFailedOperations: 0,
    totalQueuedOperations: 4,
    totalStartedOperations: 4,
    ...overrides,
  };
}

describe('createTursoQueueProfileDiagnostics', () => {
  it('accepts the shared owner topology when foreground and background work are observed below thresholds', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS(),
      },
      scheduler: schedulerSnapshot({
        backgroundYieldCount: 1,
        priorityStats: {
          background: priorityStats({
            completed: 3,
            lastCompletedLabel: 'turso.embedding-worker.queue.complete',
            started: 3,
            waitP95Ms: 120,
          }),
          foreground: priorityStats({
            completed: 2,
            lastCompletedLabel: 'assistant foreground query',
            longestWaitMs: 64,
            started: 2,
            waitP95Ms: 64,
          }),
          normal: priorityStats(),
        },
        recentCompletedOperations: [
          {
            completedAt: 955,
            enqueuedAt: 920,
            label: 'turso.embedding-worker.queue.complete',
            priority: 'background',
            serviceMs: 20,
            startedAt: 935,
            waitMs: 15,
          },
          {
            completedAt: 985,
            enqueuedAt: 955,
            label: 'assistant foreground query',
            priority: 'foreground',
            serviceMs: 20,
            startedAt: 965,
            waitMs: 10,
          },
        ],
      }),
    });

    expect(diagnostics).toMatchObject({
      foregroundWaitP95Ms: 64,
      observedBackgroundWork: true,
      observedForegroundWork: true,
      ownerSlowForegroundQueuedOperationCount: 0,
      status: 'accepted',
    });
  });

  it('blocks when foreground owner work is queued behind active background work past the threshold', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          activeOperation: {
            activeDurationMs: 1400,
            id: 1,
            kind: 'transaction',
            label: 'turso.embedding-worker.queue.complete',
            priority: 'background',
            queuedAt: 1000,
            queueWaitMs: 0,
            startedAt: 1000,
          },
          queuedOperationCount: 1,
          queuedOperations: [
            {
              id: 2,
              kind: 'query',
              label: 'assistant foreground query',
              priority: 'foreground',
              queuedAt: 1200,
              queuedForMs: 1100,
            },
          ],
          slowQueuedOperationCount: 1,
        }),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 1, started: 1 }),
          foreground: priorityStats({ completed: 1, started: 2, waitP95Ms: 40 }),
          normal: priorityStats(),
        },
        recentCompletedOperations: [
          {
            completedAt: 1015,
            enqueuedAt: 995,
            label: 'turso schema readiness',
            priority: 'background',
            serviceMs: 15,
            startedAt: 1000,
            waitMs: 5,
          },
          {
            completedAt: 985,
            enqueuedAt: 955,
            label: 'assistant foreground query',
            priority: 'foreground',
            serviceMs: 20,
            startedAt: 965,
            waitMs: 10,
          },
        ],
      }),
    });

    expect(diagnostics).toMatchObject({
      blockingForegroundLabels: ['assistant foreground query'],
      ownerSlowForegroundQueuedOperationCount: 1,
      status: 'blocked',
    });
  });

  it('accepts every owner QoS operation kind exposed by the shared diagnostics contract', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          activeOperation: {
            activeDurationMs: 20,
            id: 1,
            kind: 'exclusiveTransaction',
            label: 'turso schema readiness',
            priority: 'background',
            queuedAt: 1000,
            queueWaitMs: 0,
            startedAt: 1000,
          },
          queuedOperations: [
            {
              id: 2,
              kind: 'close',
              label: 'close stale owner',
              priority: 'background',
              queuedAt: 1010,
              queuedForMs: 5,
            },
          ],
          queuedOperationCount: 1,
        }),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({
            completed: 1,
            lastStartedLabel: 'turso schema readiness',
            started: 1,
          }),
          foreground: priorityStats({
            completed: 1,
            lastCompletedLabel: 'assistant foreground query',
            started: 1,
          }),
          normal: priorityStats(),
        },
        lastStartedAt: 1000,
        recentCompletedOperations: [
          {
            completedAt: 985,
            enqueuedAt: 955,
            label: 'assistant foreground query',
            priority: 'foreground',
            serviceMs: 20,
            startedAt: 965,
            waitMs: 10,
          },
        ],
        runningLabel: 'turso schema readiness',
        runningPriority: 'background',
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'within-thresholds',
      status: 'accepted',
    });
  });

  it('reports insufficient evidence until both foreground and background database work have been observed', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS(),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 2, started: 2 }),
          foreground: priorityStats(),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'missing-foreground-work',
      status: 'insufficient-evidence',
    });
  });

  it('reports insufficient evidence until background database work has been observed', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS(),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats(),
          foreground: priorityStats({ completed: 2, started: 2 }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'missing-background-work',
      status: 'insufficient-evidence',
    });
  });

  it('reports insufficient evidence when scheduler work has no matching owner activity', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          recentCompletedOperations: [],
          totalCompletedOperations: 0,
          totalQueuedOperations: 0,
          totalStartedOperations: 0,
        }),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 2, started: 2 }),
          foreground: priorityStats({ completed: 1, started: 1 }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'missing-owner-work',
      status: 'insufficient-evidence',
    });
  });

  it('reports insufficient evidence when owner counters predate the profiled scheduler work', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          recentCompletedOperations: [],
          totalCompletedOperations: 8,
          totalQueuedOperations: 8,
          totalStartedOperations: 8,
        }),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({
            completed: 2,
            lastCompletedLabel: 'turso.embedding-worker.queue.claimMany',
            started: 2,
          }),
          foreground: priorityStats({
            completed: 1,
            lastCompletedLabel: 'assistant foreground query',
            started: 1,
          }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'missing-owner-work',
      status: 'insufficient-evidence',
    });
  });

  it('accepts owner proof from recent scheduler completions after last labels move on', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          recentCompletedOperations: [
            {
              completedAt: 950,
              durationMs: 10,
              id: 101,
              kind: 'transaction',
              label: 'turso.embedding-worker.queue.claimMany',
              priority: 'background',
              queuedAt: 930,
              queueWaitMs: 10,
              startedAt: 940,
            },
            {
              completedAt: 980,
              durationMs: 10,
              id: 102,
              kind: 'query',
              label: 'turso.queue-profile.foreground-probe',
              priority: 'foreground',
              queuedAt: 960,
              queueWaitMs: 10,
              startedAt: 970,
            },
          ],
        }),
      },
      scheduler: schedulerSnapshotWithRecentCompleted(
        {
          priorityStats: {
            background: priorityStats({
              completed: 1,
              lastCompletedLabel: 'turso.embedding-worker.queue.claimMany',
              started: 1,
            }),
            foreground: priorityStats({
              completed: 2,
              lastCompletedLabel: 'db.diagnostics',
              started: 2,
            }),
            normal: priorityStats(),
          },
        },
        [
          {
            completedAt: 955,
            enqueuedAt: 920,
            label: 'turso.embedding-worker.queue.claimMany',
            priority: 'background',
            serviceMs: 20,
            startedAt: 935,
            waitMs: 15,
          },
          {
            completedAt: 985,
            enqueuedAt: 955,
            label: 'turso.queue-profile.foreground-probe',
            priority: 'foreground',
            serviceMs: 20,
            startedAt: 965,
            waitMs: 10,
          },
          {
            completedAt: 1100,
            enqueuedAt: 1080,
            label: 'db.diagnostics',
            priority: 'foreground',
            serviceMs: 10,
            startedAt: 1090,
            waitMs: 10,
          },
        ]
      ),
    });

    expect(diagnostics).toMatchObject({
      reason: 'within-thresholds',
      status: 'accepted',
    });
  });

  it('reports insufficient evidence when matching owner labels predate scheduler work', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS({
          recentCompletedOperations: [
            {
              completedAt: 150,
              durationMs: 10,
              id: 101,
              kind: 'transaction',
              label: 'turso.embedding-worker.queue.claimMany',
              priority: 'background',
              queuedAt: 120,
              queueWaitMs: 10,
              startedAt: 130,
            },
            {
              completedAt: 180,
              durationMs: 10,
              id: 102,
              kind: 'query',
              label: 'turso.queue-profile.foreground-probe',
              priority: 'foreground',
              queuedAt: 150,
              queueWaitMs: 10,
              startedAt: 160,
            },
          ],
        }),
      },
      scheduler: schedulerSnapshotWithRecentCompleted(
        {
          priorityStats: {
            background: priorityStats({
              completed: 1,
              lastCompletedLabel: 'turso.embedding-worker.queue.claimMany',
              started: 1,
            }),
            foreground: priorityStats({
              completed: 1,
              lastCompletedLabel: 'turso.queue-profile.foreground-probe',
              started: 1,
            }),
            normal: priorityStats(),
          },
        },
        [
          {
            completedAt: 1055,
            enqueuedAt: 1020,
            label: 'turso.embedding-worker.queue.claimMany',
            priority: 'background',
            serviceMs: 20,
            startedAt: 1035,
            waitMs: 15,
          },
          {
            completedAt: 1085,
            enqueuedAt: 1055,
            label: 'turso.queue-profile.foreground-probe',
            priority: 'foreground',
            serviceMs: 20,
            startedAt: 1065,
            waitMs: 10,
          },
        ]
      ),
    });

    expect(diagnostics).toMatchObject({
      reason: 'missing-owner-work',
      status: 'insufficient-evidence',
    });
  });

  it('blocks when foreground scheduler wait exceeds the threshold', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: ownerQoS(),
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 2, started: 2 }),
          foreground: priorityStats({ completed: 1, started: 1, waitP95Ms: 1200 }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      foregroundWaitP95Ms: 1200,
      reason: 'foreground-scheduler-wait-threshold-exceeded',
      status: 'blocked',
    });
  });

  it('fails closed when Turso owner QoS diagnostics are malformed', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: {
          available: true,
          queuedOperations: [],
          slowQueueThresholdMs: 1000,
        },
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 1, started: 1 }),
          foreground: priorityStats({ completed: 1, started: 1 }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'owner-diagnostics-malformed',
      status: 'unavailable',
    });
  });

  it('preserves a runtime-not-turso owner QoS unavailable reason under a Turso bootstrap report', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'turso' },
        },
        tursoOwnerClientQoS: { available: false, reason: 'runtime-not-turso' },
      },
      scheduler: schedulerSnapshot({
        priorityStats: {
          background: priorityStats({ completed: 1, started: 1 }),
          foreground: priorityStats({ completed: 1, started: 1 }),
          normal: priorityStats(),
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      reason: 'runtime-not-turso',
      status: 'unavailable',
    });
  });

  it('stays unavailable when runtime diagnostics are not Turso owner diagnostics', () => {
    const diagnostics = createTursoQueueProfileDiagnostics({
      databaseDiagnostics: {
        profileBootstrapReport: {
          runtime: { engine: 'pglite' },
        },
        tursoOwnerClientQoS: { available: false, reason: 'runtime-not-turso' },
      },
      scheduler: schedulerSnapshot(),
    });

    expect(diagnostics).toMatchObject({
      reason: 'runtime-not-turso',
      status: 'unavailable',
    });
  });
});
