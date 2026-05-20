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
  readonly databaseScheduler: unknown;
  readonly embeddingHost: RuntimeHostPlatformStatus<'embedding-host'>;
  readonly indexing: {
    readonly activeBackfills: readonly EmbeddingHostBackfillInfo[];
    readonly databaseWork: unknown;
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
    readonly getSnapshot: () => unknown;
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
  const database = await providers.database.getDiagnostics();
  const databaseScheduler = providers.databaseScheduler.getSnapshot();
  const activeBackfills = await providers.indexing.getBackfillsInFlight();

  return {
    collectedAt: new Date().toISOString(),
    crashRecovery: providers.crashRecovery.getSnapshot(),
    database,
    databaseScheduler,
    embeddingHost: providers.embeddingHost.getPlatformStatus(),
    indexing: {
      activeBackfills,
      databaseWork: databaseScheduler,
    },
    llmHost: providers.llmHost.getPlatformStatus(),
    logging: providers.logging.getState(),
    migration: {
      attemptCount: getNumberValue(database, 'initializationAttemptCount'),
      inFlight: getBooleanValue(database, 'initializationInFlight'),
      lastFailure: getRecordValue(database, 'lastInitializationFailure') ?? null,
      lastSucceededAt: getStringOrNullValue(database, 'lastInitializationSucceededAt'),
    },
    reset: providers.reset.getSnapshot(),
    telemetry: {
      backgroundRuntimeMetrics: providers.telemetry.getRuntimeMetrics(),
    },
  };
}
