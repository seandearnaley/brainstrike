import type { LoggingSettingsPayload } from './logging-shared';
import type { RuntimeHostPlatformStatus } from './platform/runtime-host-state';

export const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot' as const;

export interface DesktopPlatformDiagnosticsSnapshot {
  readonly collectedAt: string;
  readonly database: unknown;
  readonly databaseScheduler: unknown;
  readonly embeddingHost: RuntimeHostPlatformStatus<'embedding-host'>;
  readonly llmHost: RuntimeHostPlatformStatus<'llm-host'>;
  readonly logging: LoggingSettingsPayload;
  readonly reset: {
    readonly userDataPath: string;
  };
}

export interface DesktopPlatformDiagnosticsProviders {
  readonly database: {
    readonly getDiagnostics: () => Promise<unknown> | unknown;
  };
  readonly databaseScheduler: {
    readonly getSnapshot: () => unknown;
  };
  readonly embeddingHost: {
    readonly getPlatformStatus: () => RuntimeHostPlatformStatus<'embedding-host'>;
  };
  readonly llmHost: {
    readonly getPlatformStatus: () => RuntimeHostPlatformStatus<'llm-host'>;
  };
  readonly logging: {
    readonly getState: () => LoggingSettingsPayload;
  };
  readonly reset: {
    readonly getUserDataPath: () => string;
  };
}

export async function collectDesktopPlatformDiagnostics(
  providers: DesktopPlatformDiagnosticsProviders
): Promise<DesktopPlatformDiagnosticsSnapshot> {
  const database = await providers.database.getDiagnostics();

  return {
    collectedAt: new Date().toISOString(),
    database,
    databaseScheduler: providers.databaseScheduler.getSnapshot(),
    embeddingHost: providers.embeddingHost.getPlatformStatus(),
    llmHost: providers.llmHost.getPlatformStatus(),
    logging: providers.logging.getState(),
    reset: {
      userDataPath: providers.reset.getUserDataPath(),
    },
  };
}
