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
      runtimeCorruptionRecoveryCount: 1,
      lastRuntimeCorruptionAt: '2026-05-20T18:01:00.000Z',
      lastRuntimeCorruptionContext: 'db:query',
    };
    const schedulerSnapshot = { activeCount: 0 };
    const activeBackfills = [
      {
        embeddingSetId: 'set-1',
        progress: { current: 2, total: 4 },
        requestId: 'background-indexing-backfill:set-1',
        source: 'background-indexing' as const,
      },
    ];
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
      capabilities: { fileDestination: true },
      preferences: {
        console: true,
        file: { enabled: false, path: null },
        level: 'info',
        redactPaths: [],
      },
    };

    const snapshot = await collectDesktopPlatformDiagnostics({
      crashRecovery: { getSnapshot: vi.fn(() => crashRecovery) },
      database: { getDiagnostics: vi.fn(async () => databaseDiagnostics) },
      databaseScheduler: { getSnapshot: vi.fn(() => schedulerSnapshot) },
      embeddingHost: { getPlatformStatus: vi.fn(() => embeddingHostStatus) },
      indexing: { getBackfillsInFlight: vi.fn(() => activeBackfills) },
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
      indexing: {
        activeBackfills,
        databaseWork: schedulerSnapshot,
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
        userDataPath: '/tmp/brainstrike-user-data',
        status: 'idle',
      },
      telemetry: {
        backgroundRuntimeMetrics: runtimeMetrics,
      },
    });
    expect(Date.parse(snapshot.collectedAt)).not.toBeNaN();
  });
});
