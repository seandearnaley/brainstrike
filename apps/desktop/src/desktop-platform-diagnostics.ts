import type { DatabaseWorkSchedulerSnapshot } from '@brainstrike/db';
import { LogLevel } from '@brainstrike/utils/logger';
import type { BackgroundRuntimeProcessMetric } from './background-runtime-metrics';
import type { DesktopRendererCrashRecoverySnapshot } from './desktop-crash-recovery';
import type { DesktopResetDiagnosticsSnapshot } from './desktop-reset-diagnostics';
import type { EmbeddingHostBackfillInfo } from './embedding-host-shared';
import type { LoggingSettingsPayload } from './logging-shared';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import type { RuntimeHostPlatformStatus } from './platform/runtime-host-state';

export const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL =
  DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot;

export interface DesktopPlatformDiagnosticsSnapshot {
  readonly collectedAt: string;
  readonly crashRecovery: DesktopRendererCrashRecoverySnapshot;
  readonly database: unknown;
  readonly databaseScheduler: DatabaseWorkSchedulerSnapshot | null;
  readonly embeddingHost: RuntimeHostPlatformStatus<'embedding-host'>;
  readonly errors: Partial<Record<DesktopPlatformDiagnosticsProviderName, string>>;
  readonly indexing: {
    readonly activeBackfills: readonly EmbeddingHostBackfillInfo[];
    readonly databaseWork: {
      readonly scheduler: DatabaseWorkSchedulerSnapshot | null;
    };
  };
  readonly llmHost: RuntimeHostPlatformStatus<'llm-host'>;
  readonly logging: LoggingSettingsPayload;
  readonly migration: {
    readonly attemptCount: number | null;
    readonly inFlight: boolean | null;
    readonly lastFailure: unknown;
    readonly lastSucceededAt: string | null;
  };
  readonly reset: DesktopResetDiagnosticsSnapshot;
  readonly telemetry: {
    readonly backgroundRuntimeMetrics: readonly BackgroundRuntimeProcessMetric[];
  };
}

export interface DesktopPlatformDiagnosticsProviders {
  readonly crashRecovery: {
    readonly getSnapshot: () => DesktopRendererCrashRecoverySnapshot;
  };
  readonly database: {
    readonly getDiagnostics: () => Promise<unknown> | unknown;
  };
  readonly databaseScheduler: {
    readonly getSnapshot: () => DatabaseWorkSchedulerSnapshot;
  };
  readonly embeddingHost: {
    readonly getPlatformStatus: () => RuntimeHostPlatformStatus<'embedding-host'>;
  };
  readonly indexing: {
    readonly getBackfillsInFlight: () =>
      | Promise<readonly EmbeddingHostBackfillInfo[]>
      | readonly EmbeddingHostBackfillInfo[];
  };
  readonly llmHost: {
    readonly getPlatformStatus: () => RuntimeHostPlatformStatus<'llm-host'>;
  };
  readonly logging: {
    readonly getState: () => LoggingSettingsPayload;
  };
  readonly reset: {
    readonly getSnapshot: () => DesktopResetDiagnosticsSnapshot;
  };
  readonly telemetry: {
    readonly getRuntimeMetrics: () => readonly BackgroundRuntimeProcessMetric[];
  };
}

type DesktopPlatformDiagnosticsProviderName =
  | 'activeBackfills'
  | 'crashRecovery'
  | 'database'
  | 'databaseScheduler'
  | 'embeddingHost'
  | 'llmHost'
  | 'logging'
  | 'reset'
  | 'telemetry';

async function readDiagnosticsProvider<T>(
  errors: Partial<Record<DesktopPlatformDiagnosticsProviderName, string>>,
  name: DesktopPlatformDiagnosticsProviderName,
  read: () => Promise<T> | T,
  fallback: T
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

function getRecordValue(record: unknown, key: string): unknown {
  if (!(record && typeof record === 'object')) {
    return;
  }
  return (record as Record<string, unknown>)[key];
}

function getNumberValue(record: unknown, key: string): number | null {
  const value = getRecordValue(record, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getBooleanValue(record: unknown, key: string): boolean | null {
  const value = getRecordValue(record, key);
  return typeof value === 'boolean' ? value : null;
}

function getStringOrNullValue(record: unknown, key: string): string | null {
  const value = getRecordValue(record, key);
  return typeof value === 'string' ? value : null;
}

export async function collectDesktopPlatformDiagnostics(
  providers: DesktopPlatformDiagnosticsProviders
): Promise<DesktopPlatformDiagnosticsSnapshot> {
  const errors: Partial<Record<DesktopPlatformDiagnosticsProviderName, string>> = {};
  const database = await readDiagnosticsProvider(
    errors,
    'database',
    () => providers.database.getDiagnostics(),
    null
  );
  const databaseScheduler = await readDiagnosticsProvider(
    errors,
    'databaseScheduler',
    () => providers.databaseScheduler.getSnapshot(),
    null
  );
  const activeBackfills = await readDiagnosticsProvider(
    errors,
    'activeBackfills',
    () => providers.indexing.getBackfillsInFlight(),
    []
  );
  const reset = await readDiagnosticsProvider(
    errors,
    'reset',
    () => providers.reset.getSnapshot(),
    {
      lastCompletedAt: null,
      lastDeletedPathCount: 0,
      lastError: 'reset diagnostics unavailable',
      lastFailedAt: null,
      lastPreservedPathCount: 0,
      lastStartedAt: null,
      status: 'failed',
      userDataPath: '<unavailable>',
    }
  );

  return {
    collectedAt: new Date().toISOString(),
    crashRecovery: await readDiagnosticsProvider(
      errors,
      'crashRecovery',
      () => providers.crashRecovery.getSnapshot(),
      {
        lastRendererCrashAt: null,
        lastRendererCrashExitCode: null,
        lastRendererCrashReason: null,
        lastRendererCrashWindowRole: null,
        lastRendererReloadAt: null,
        lastRendererReloadWindowRole: null,
        pendingRendererRecovery: false,
        rendererCrashCount: 0,
        rendererReloadAttemptCount: 0,
        suppressedRendererReloadCount: 0,
      }
    ),
    database,
    databaseScheduler,
    embeddingHost: await readDiagnosticsProvider(
      errors,
      'embeddingHost',
      () => providers.embeddingHost.getPlatformStatus(),
      {
        active: false,
        lastError: 'embedding host diagnostics unavailable',
        pendingRequestCount: 0,
        runtimeId: 'embedding-host:unavailable',
        runtimeKind: 'embedding-host',
        sourceState: 'error',
        state: 'failed',
      }
    ),
    errors,
    indexing: {
      activeBackfills,
      databaseWork: { scheduler: databaseScheduler },
    },
    llmHost: await readDiagnosticsProvider(
      errors,
      'llmHost',
      () => providers.llmHost.getPlatformStatus(),
      {
        active: false,
        lastError: 'llm host diagnostics unavailable',
        pendingRequestCount: 0,
        runtimeId: 'llm-host:unavailable',
        runtimeKind: 'llm-host',
        sourceState: 'error',
        state: 'failed',
      }
    ),
    logging: await readDiagnosticsProvider(errors, 'logging', () => providers.logging.getState(), {
      capabilities: {
        canSelectDestination: false,
        defaultDestination: null,
        fileLoggingSupported: false,
        reason: 'logging diagnostics unavailable',
        runtime: 'electron',
      },
      preferences: {
        consoleEnabled: false,
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
    }),
    migration: {
      attemptCount: getNumberValue(database, 'initializationAttemptCount'),
      inFlight: getBooleanValue(database, 'initializationInFlight'),
      lastFailure: getRecordValue(database, 'lastInitializationFailure') ?? null,
      lastSucceededAt: getStringOrNullValue(database, 'lastInitializationSucceededAt'),
    },
    reset: { ...reset, userDataPath: '<redacted>' },
    telemetry: {
      backgroundRuntimeMetrics: await readDiagnosticsProvider(
        errors,
        'telemetry',
        () => providers.telemetry.getRuntimeMetrics(),
        []
      ),
    },
  };
}
