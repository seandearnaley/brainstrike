import { LogLevel } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  collectDesktopPlatformDiagnostics,
  type DesktopPlatformDiagnosticsProviders,
} from '../desktop-platform-diagnostics';

describe('desktop platform diagnostics', () => {
  it('collects one typed snapshot across database, hosts and logging', async () => {
    const databaseDiagnostics = {
      hasDatabaseHandle: true,
      initializationAttemptCount: 2,
      initializationInFlight: false,
      initStop: {
        budgetMs: 372_000,
        consecutiveTimeouts: 2,
        hostPid: 4242,
        lastTimeoutAt: '2026-05-20T17:59:00.000Z',
        phaseKey: 'index-rebuild:public.idx_file_chunks_content_bm25',
        report: null,
        version: 1 as const,
      },
      lastInitializationFailure: null,
      lastInitializationSucceededAt: '2026-05-20T18:00:00.000Z',
    };
    const databaseIntegrity = {
      revision: 1,
      state: {
        context: 'db:query' as const,
        kind: 'contained' as const,
        signal: { message: 'invalid page in block 3', sqlstate: 'XX001' as const },
        since: '2026-05-20T18:01:00.000Z',
      },
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
    const processCounters = {
      installedAt: '2026-05-20T17:59:00.000Z',
      samples: [
        {
          at: '2026-05-20T18:00:30.000Z',
          backgroundTasks: { pending: 1, running: 2, suspended: 0 },
          heapUsedKb: 1024,
          rssKb: 4096,
          wasm: { compile: 0, failures: 0, instance: 3, instantiate: 3, memory: 3 },
          wasmRecentFailures: [],
        },
      ],
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
    const embeddingTelemetry = {
      batchTransfer: { batchCount: 2, lastBytes: 12, peakBytes: 24, totalBytes: 36 },
      cache: {
        entries: [],
        estimatedGpuBytes: 0,
        estimatedHeapBytes: 0,
        memoryEstimateUnavailableCount: 0,
        residentCount: 0,
      },
      lastUpdatedAt: 1000,
      peakVectorsInFlight: 3,
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

    const providers: DesktopPlatformDiagnosticsProviders = {
      crashRecovery: { getSnapshot: vi.fn(() => crashRecovery) },
      database: { getDiagnostics: vi.fn(async () => databaseDiagnostics) },
      databaseIntegrity: { getSnapshot: vi.fn(() => databaseIntegrity) },
      embeddingHost: {
        getPlatformStatus: vi.fn(() => embeddingHostStatus),
        getTelemetrySnapshot: vi.fn(() => embeddingTelemetry),
      },
      logging: { getState: vi.fn(() => loggingState) },
      processCounters: { getSnapshot: vi.fn(() => processCounters) },
      telemetry: { getRuntimeMetrics: vi.fn(() => runtimeMetrics) },
    } as unknown as DesktopPlatformDiagnosticsProviders;
    const snapshot = await collectDesktopPlatformDiagnostics(providers);

    expect(snapshot).toMatchObject({
      crashRecovery,
      database: databaseDiagnostics,
      databaseIntegrity,
      embeddingHost: embeddingHostStatus,
      errors: {},
      logging: loggingState,
      migration: {
        attemptCount: 2,
        inFlight: false,
        initStop: databaseDiagnostics.initStop,
        lastFailure: null,
        lastSucceededAt: '2026-05-20T18:00:00.000Z',
      },
      telemetry: {
        backgroundRuntimeMetrics: runtimeMetrics,
        embedding: embeddingTelemetry,
        processCounters,
      },
    });
    const currentOwner = { owner: 'agent-host', storage: 'sqlite' };
    const native = await collectDesktopPlatformDiagnostics({
      ...providers,
      database: { getDiagnostics: () => currentOwner },
      databaseIntegrity: null,
    });
    expect(native.database).toEqual(currentOwner);
    expect(native.databaseIntegrity).toBeNull();
    expect(snapshot.errors).toEqual({});
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
      databaseIntegrity: {
        getSnapshot: vi.fn(() => ({ revision: 0, state: { kind: 'healthy' as const } })),
      },
      embeddingHost: {
        getPlatformStatus: vi.fn(() => {
          throw new Error('embedding unavailable');
        }),
        getTelemetrySnapshot: vi.fn(() => {
          throw new Error('embedding telemetry unavailable');
        }),
      },
      logging: {
        getState: vi.fn(() => {
          throw new Error('logging unavailable');
        }),
      },
      mainLog: {
        readWindow: vi.fn(() => Promise.reject(new Error('main log unavailable'))),
      },
      processCounters: {
        getSnapshot: vi.fn(() => {
          throw new Error('process counters unavailable');
        }),
      },
      telemetry: {
        getRuntimeMetrics: vi.fn(() => {
          throw new Error('telemetry unavailable');
        }),
      },
    });

    expect(snapshot.errors).toMatchObject({
      crashRecovery: 'crash unavailable',
      embeddingHost: 'embedding unavailable',
      embeddingTelemetry: 'embedding telemetry unavailable',
      logging: 'logging unavailable',
      processCounters: 'process counters unavailable',
      telemetry: 'telemetry unavailable',
    });
    expect(snapshot.telemetry.processCounters).toEqual({ installedAt: null, samples: [] });
    expect(snapshot.databaseIntegrity).toEqual({ revision: 0, state: { kind: 'healthy' } });
    // No stop is reported as none, never as absent.
    expect(snapshot.migration.initStop).toBeNull();
  });
});
