import type {
  DatabaseWorkSchedulerSnapshot,
  DimensionIndexMaintenanceRow,
  DimensionIndexSuspensionRow,
} from '@brainstrike/db';
import {
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import { LogLevel } from '@brainstrike/logging';
import type { DatabaseIntegritySnapshot } from '@brainstrike/types';
import type { BackgroundRuntimeProcessMetric } from './background-runtime-metrics';
import type { DesktopRendererCrashRecoverySnapshot } from './desktop-crash-recovery';
import type { DesktopResetDiagnosticsSnapshot } from './desktop-reset-diagnostics';
import type { MainLogWindowRequest, MainLogWindowResult } from './diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from './diagnostics/process-counter-ring';
import type { LoggingSettingsPayload } from './logging-shared';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import type { RuntimeHostPlatformStatus } from './platform/runtime-host-state';

export const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL =
  DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot;

export interface DesktopPlatformDiagnosticsSnapshot {
  readonly collectedAt: string;
  readonly crashRecovery: DesktopRendererCrashRecoverySnapshot;
  readonly database: unknown;
  /** Main-owned integrity state; the DB host never sees runtime classification. */
  readonly databaseIntegrity: DatabaseIntegritySnapshot | null;
  readonly databaseScheduler: DatabaseWorkSchedulerSnapshot | null;
  readonly embeddingHost: RuntimeHostPlatformStatus<'embedding-host'>;
  readonly errors: Partial<Record<DesktopPlatformDiagnosticsProviderName, string>>;
  readonly indexing: {
    readonly legacyDatabaseMaintenance?: 'not-applicable';
    readonly databaseWork: {
      readonly scheduler: DatabaseWorkSchedulerSnapshot | null;
    };
    readonly dimensionIndexMaintenance: DesktopDimensionIndexMaintenanceSnapshot | null;
  };
  readonly logging: LoggingSettingsPayload;
  readonly migration: {
    readonly attemptCount: number | null;
    readonly inFlight: boolean | null;
    /** Main's stop after repeated init timeouts (`DatabaseInitAttemptRecord`), or null. */
    readonly initStop: unknown;
    readonly lastFailure: unknown;
    readonly lastSucceededAt: string | null;
  };
  readonly reset: DesktopResetDiagnosticsSnapshot;
  readonly telemetry: {
    readonly backgroundRuntimeMetrics: readonly BackgroundRuntimeProcessMetric[];
    readonly embedding: EmbeddingTelemetrySnapshot;
    readonly processCounters: ProcessCounterSnapshot;
  };
}

export interface DesktopDimensionIndexMaintenanceSnapshot {
  readonly maintenance: readonly DimensionIndexMaintenanceRow[];
  readonly suspensions: readonly DimensionIndexSuspensionRow[];
}

export interface DesktopPlatformDiagnosticsProviders {
  readonly crashRecovery: {
    readonly getSnapshot: () => DesktopRendererCrashRecoverySnapshot;
  };
  readonly database: {
    readonly getDiagnostics: () => Promise<unknown> | unknown;
  };
  readonly databaseIntegrity: {
    readonly getSnapshot: () => DatabaseIntegritySnapshot;
  } | null;
  readonly databaseScheduler: {
    readonly getSnapshot: () => DatabaseWorkSchedulerSnapshot;
  } | null;
  readonly embeddingHost: {
    readonly getPlatformStatus: () => RuntimeHostPlatformStatus<'embedding-host'>;
    readonly getTelemetrySnapshot: () => EmbeddingTelemetrySnapshot;
  };
  readonly indexing: {
    readonly getDimensionIndexMaintenanceSnapshot: () =>
      | Promise<DesktopDimensionIndexMaintenanceSnapshot>
      | DesktopDimensionIndexMaintenanceSnapshot;
  } | null;
  readonly logging: {
    readonly getState: () => LoggingSettingsPayload;
  };
  readonly mainLog: {
    /** Throws when file logging is disabled; the IPC rejects visibly. */
    readonly readWindow: (request: MainLogWindowRequest) => Promise<MainLogWindowResult>;
  };
  readonly processCounters: {
    readonly getSnapshot: () => ProcessCounterSnapshot;
  };
  readonly reset: {
    readonly getSnapshot: () => DesktopResetDiagnosticsSnapshot;
  };
  readonly telemetry: {
    readonly getRuntimeMetrics: () => readonly BackgroundRuntimeProcessMetric[];
  };
}

type DesktopPlatformDiagnosticsProviderName =
  | 'crashRecovery'
  | 'database'
  | 'databaseScheduler'
  | 'dimensionIndexMaintenance'
  | 'embeddingHost'
  | 'embeddingTelemetry'
  | 'logging'
  | 'processCounters'
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
    () => providers.databaseScheduler?.getSnapshot() ?? null,
    null
  );
  const dimensionIndexMaintenance = await readDiagnosticsProvider(
    errors,
    'dimensionIndexMaintenance',
    () => providers.indexing?.getDimensionIndexMaintenanceSnapshot() ?? null,
    { maintenance: [], suspensions: [] }
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
    // In-memory read with no fallback: there is no honest stand-in value, and a
    // fabricated 'healthy' would hide exactly what this field exists to show.
    databaseIntegrity: providers.databaseIntegrity?.getSnapshot() ?? null,
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
      ...(providers.indexing === null
        ? { legacyDatabaseMaintenance: 'not-applicable' as const }
        : {}),
      databaseWork: { scheduler: databaseScheduler },
      dimensionIndexMaintenance,
    },
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
      initStop: getRecordValue(database, 'initStop') ?? null,
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
      embedding: await readDiagnosticsProvider(
        errors,
        'embeddingTelemetry',
        () => providers.embeddingHost.getTelemetrySnapshot(),
        createEmptyEmbeddingTelemetrySnapshot()
      ),
      processCounters: await readDiagnosticsProvider(
        errors,
        'processCounters',
        () => providers.processCounters.getSnapshot(),
        { installedAt: null, samples: [] }
      ),
    },
  };
}
