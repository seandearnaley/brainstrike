import { LogLevel } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  collectDesktopPlatformDiagnostics,
  type DesktopPlatformDiagnosticsProviders,
} from '../desktop-platform-diagnostics';

describe('desktop platform diagnostics', () => {
  it('collects one typed snapshot across database, hosts, logging, and reset state', async () => {
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
      logging: { getState: vi.fn(() => loggingState) },
      processCounters: { getSnapshot: vi.fn(() => processCounters) },
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
    } as unknown as DesktopPlatformDiagnosticsProviders;
    const snapshot = await collectDesktopPlatformDiagnostics(providers);

    expect(snapshot).toMatchObject({
      crashRecovery,
      database: databaseDiagnostics,
      databaseIntegrity,
      errors: {},
      logging: loggingState,
      migration: {
        attemptCount: 2,
        inFlight: false,
        initStop: databaseDiagnostics.initStop,
        lastFailure: null,
        lastSucceededAt: '2026-05-20T18:00:00.000Z',
      },
      reset: {
        status: 'idle',
        userDataPath: '<redacted>',
      },
      telemetry: {
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
      crashDumps: {
        list: vi.fn(() => Promise.reject(new Error('crash dumps unavailable'))),
      },
      crashRecovery: {
        getSnapshot: vi.fn(() => {
          throw new Error('crash unavailable');
        }),
      },
      database: { getDiagnostics: vi.fn(async () => ({ initializationAttemptCount: 1 })) },
      databaseIntegrity: {
        getSnapshot: vi.fn(() => ({ revision: 0, state: { kind: 'healthy' as const } })),
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
      reset: {
        getSnapshot: vi.fn(() => {
          throw new Error('reset unavailable');
        }),
      },
    });

    expect(snapshot.errors).toMatchObject({
      crashRecovery: 'crash unavailable',
      logging: 'logging unavailable',
      processCounters: 'process counters unavailable',
      reset: 'reset unavailable',
    });
    expect(snapshot.telemetry.processCounters).toEqual({ installedAt: null, samples: [] });
    expect(snapshot.databaseIntegrity).toEqual({ revision: 0, state: { kind: 'healthy' } });
    expect(snapshot.reset.userDataPath).toBe('<redacted>');
    // No stop is reported as none, never as absent.
    expect(snapshot.migration.initStop).toBeNull();
  });
});
