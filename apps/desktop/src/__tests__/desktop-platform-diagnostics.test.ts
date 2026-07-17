import { LogLevel } from '@brainstrike/utils/logger';
import { describe, expect, it, vi } from 'vitest';
import { collectDesktopPlatformDiagnostics } from '../desktop-platform-diagnostics';

describe('desktop platform diagnostics', () => {
  it('collects one typed snapshot across database, scheduler, hosts, logging, and reset state', async () => {
    const databaseDiagnostics = {
      hasDatabaseHandle: true,
      initializationAttemptCount: 2,
      initializationInFlight: false,
      lastInitializationFailure: null,
      lastInitializationSucceededAt: '2026-05-20T18:00:00.000Z',
      lastRuntimeCorruptionAt: '2026-05-20T18:01:00.000Z',
      lastRuntimeCorruptionContext: 'db:query',
      runtimeCorruptionRecoveryCount: 1,
    };
    const priorityStats = {
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
    };
    const schedulerSnapshot = {
      backgroundWaiting: false,
      backgroundWaitingSince: null,
      backgroundYieldCount: 0,
      currentBackgroundWaitMs: 0,
      foregroundQuietMs: 250,
      lastBackgroundYieldAt: null,
      lastCompletedAt: null,
      lastForegroundAt: null,
      lastNormalAt: null,
      lastStartedAt: null,
      priorityStats: {
        background: priorityStats,
        foreground: priorityStats,
        normal: priorityStats,
      },
      queued: { background: 0, foreground: 0, normal: 0 },
      runningLabel: null,
      runningPriority: null,
      snapshotAt: 1,
    };
    const activeBackfills = [
      {
        embeddingSetId: 'set-1',
        progress: { current: 2, total: 4 },
        requestId: 'background-indexing-backfill:set-1',
        source: 'background-indexing' as const,
      },
    ];
    const dimensionIndexMaintenance = {
      maintenance: [
        {
          attempts: 1,
          completedAt: null,
          dimension: 384,
          lastDurationMs: null,
          lastError: null,
          lastForegroundProbeMaxMs: null,
          lastForegroundProbeP95Ms: null,
          lastInvalidIndexName: null,
          nextRunAt: '2026-05-20T18:03:00.000Z',
          reason: 'embedding-backfill:set-1',
          requestedAt: '2026-05-20T18:02:30.000Z',
          startedAt: null,
          state: 'pending' as const,
          strategy: 'regular' as const,
        },
      ],
      suspensions: [
        {
          dimension: 384,
          reason: 'nonblocking-background-indexing',
          suspendedAt: '2026-05-20T18:02:00.000Z',
        },
      ],
    };
    const crashRecovery = {
      lastRendererCrashAt: '2026-05-20T18:02:00.000Z',
      lastRendererCrashReason: 'crashed',
      lastRendererReloadAt: null,
      pendingRendererRecovery: true,
      rendererCrashCount: 1,
      rendererReloadAttemptCount: 0,
      suppressedRendererReloadCount: 0,
    };
    const runtimeMetrics = [
      {
        cpuPercent: '1.0',
        idleWakeupsPerSecond: '0.0',
        osProcessId: 123,
        privateKb: '1000',
        runtimeKind: 'embedding-host' as const,
        sharedKb: '200',
        workingSetKb: '1200',
      },
    ];
    const embeddingHostStatus = {
      active: false,
      lastError: null,
      pendingRequestCount: 0,
      runtimeId: 'embedding-host:stopped',
      runtimeKind: 'embedding-host' as const,
      sourceState: 'stopped' as const,
      state: 'stopped' as const,
    };
    const llmHostStatus = {
      active: true,
      lastError: null,
      pendingRequestCount: 1,
      runtimeId: 'llm-host:running',
      runtimeKind: 'llm-host' as const,
      sourceState: 'running' as const,
      state: 'active' as const,
    };
    const loggingState = {
      capabilities: {
        canSelectDestination: true,
        defaultDestination: '/tmp/brainstrike.log',
        fileLoggingSupported: true,
        runtime: 'electron' as const,
      },
      preferences: {
        consoleEnabled: true,
        consoleLevel: LogLevel.INFO,
        file: {
          append: true,
          destination: null,
          enabled: false,
          level: LogLevel.INFO,
          mkdir: true,
        },
        includeTimestamp: false,
        level: LogLevel.INFO,
        redactPaths: [],
      },
    };

    const snapshot = await collectDesktopPlatformDiagnostics({
      crashRecovery: { getSnapshot: vi.fn(() => crashRecovery) },
      database: { getDiagnostics: vi.fn(async () => databaseDiagnostics) },
      databaseScheduler: { getSnapshot: vi.fn(() => schedulerSnapshot) },
      embeddingHost: { getPlatformStatus: vi.fn(() => embeddingHostStatus) },
      indexing: {
        getBackfillsInFlight: vi.fn(() => activeBackfills),
        getDimensionIndexMaintenanceSnapshot: vi.fn(() => dimensionIndexMaintenance),
      },
      llmHost: { getPlatformStatus: vi.fn(() => llmHostStatus) },
      logging: { getState: vi.fn(() => loggingState) },
      reset: {
        getSnapshot: vi.fn(() => ({
          lastCompletedAt: null,
          lastDeletedPathCount: 0,
          lastError: null,
          lastFailedAt: null,
          lastPreservedPathCount: 0,
          status: 'idle' as const,
          userDataPath: '/tmp/brainstrike-user-data',
        })),
      },
      telemetry: { getRuntimeMetrics: vi.fn(() => runtimeMetrics) },
    });

    expect(snapshot).toMatchObject({
      crashRecovery,
      database: databaseDiagnostics,
      databaseScheduler: schedulerSnapshot,
      embeddingHost: embeddingHostStatus,
      errors: {},
      indexing: {
        activeBackfills,
        databaseWork: {
          scheduler: schedulerSnapshot,
        },
        dimensionIndexMaintenance,
      },
      llmHost: llmHostStatus,
      logging: loggingState,
      migration: {
        attemptCount: 2,
        inFlight: false,
        lastFailure: null,
        lastSucceededAt: '2026-05-20T18:00:00.000Z',
      },
      reset: {
        status: 'idle',
        userDataPath: '<redacted>',
      },
      telemetry: {
        backgroundRuntimeMetrics: runtimeMetrics,
      },
    });
    expect(Date.parse(snapshot.collectedAt)).not.toBeNaN();
  });

  it('returns partial diagnostics with provider errors when one source fails', async () => {
    const snapshot = await collectDesktopPlatformDiagnostics({
      crashRecovery: {
        getSnapshot: vi.fn(() => {
          throw new Error('crash unavailable');
        }),
      },
      database: { getDiagnostics: vi.fn(async () => ({ initializationAttemptCount: 1 })) },
      databaseScheduler: {
        getSnapshot: vi.fn(() => {
          throw new Error('scheduler unavailable');
        }),
      },
      embeddingHost: {
        getPlatformStatus: vi.fn(() => {
          throw new Error('embedding unavailable');
        }),
      },
      indexing: {
        getBackfillsInFlight: vi.fn(() => {
          throw new Error('backfills unavailable');
        }),
        getDimensionIndexMaintenanceSnapshot: vi.fn(() => {
          throw new Error('dimension maintenance unavailable');
        }),
      },
      llmHost: {
        getPlatformStatus: vi.fn(() => {
          throw new Error('llm unavailable');
        }),
      },
      logging: {
        getState: vi.fn(() => {
          throw new Error('logging unavailable');
        }),
      },
      reset: {
        getSnapshot: vi.fn(() => {
          throw new Error('reset unavailable');
        }),
      },
      telemetry: {
        getRuntimeMetrics: vi.fn(() => {
          throw new Error('telemetry unavailable');
        }),
      },
    });

    expect(snapshot.errors).toMatchObject({
      activeBackfills: 'backfills unavailable',
      crashRecovery: 'crash unavailable',
      databaseScheduler: 'scheduler unavailable',
      dimensionIndexMaintenance: 'dimension maintenance unavailable',
      embeddingHost: 'embedding unavailable',
      llmHost: 'llm unavailable',
      logging: 'logging unavailable',
      reset: 'reset unavailable',
      telemetry: 'telemetry unavailable',
    });
    expect(snapshot.databaseScheduler).toBeNull();
    expect(snapshot.indexing.activeBackfills).toEqual([]);
    expect(snapshot.indexing.dimensionIndexMaintenance).toEqual({
      maintenance: [],
      suspensions: [],
    });
    expect(snapshot.reset.userDataPath).toBe('<redacted>');
  });
});
