import { createLogger, type LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import {
  assertBufferedLogRecord,
  assertLoggingOpenDestinationTarget,
  assertLoggingPreferences,
  LOGGING_API_CHANNELS,
} from './platform/logging-api-contract';

const logger = createLogger('LoggingIPC');

export interface LoggingIpcHandlers {
  getBufferedLogs: () => readonly LogRecord[];
  getState: () => LoggingSettingsPayload;
  ingestBufferedLog: (senderId: number, record: LogRecord) => void;
  openDestination: (target: string | null) => Promise<boolean>;
  selectDestination: () => Promise<string | null>;
  setPreferences: (
    preferences: LoggingPreferences
  ) => LoggingSettingsPayload | Promise<LoggingSettingsPayload>;
}

export function registerLoggingIpcHandlers(handlers: LoggingIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('logging', LOGGING_API_CHANNELS.getPreferences, () =>
    handlers.getState()
  );

  let preferencesUpdateQueue: Promise<void> = Promise.resolve();

  registry.registerInvoke(
    'logging',
    LOGGING_API_CHANNELS.setPreferences,
    async (_event, preferences: unknown): Promise<LoggingSettingsPayload> => {
      const parsedPreferences = assertLoggingPreferences(preferences);
      const runUpdate = async (): Promise<LoggingSettingsPayload> => {
        const payload = await handlers.setPreferences(parsedPreferences);
        broadcastLoggingPreferences(payload.preferences);
        return payload;
      };

      const queuedUpdate = preferencesUpdateQueue.then(runUpdate, runUpdate);
      preferencesUpdateQueue = queuedUpdate.then(
        () => undefined,
        () => undefined
      );

      return queuedUpdate;
    }
  );

  registry.registerInvoke('logging', LOGGING_API_CHANNELS.selectDestination, async () =>
    handlers.selectDestination()
  );

  registry.registerInvoke(
    'logging',
    LOGGING_API_CHANNELS.openDestination,
    async (_event, target: unknown): Promise<boolean> =>
      handlers.openDestination(assertLoggingOpenDestinationTarget(target))
  );

  registry.registerInvoke('logging', LOGGING_API_CHANNELS.getBufferedLogs, async () =>
    handlers.getBufferedLogs()
  );
  registry.registerEvent('logging', LOGGING_API_CHANNELS.ingestBufferedRecord, (event, payload) => {
    handlers.ingestBufferedLog(event.sender.id, assertBufferedLogRecord(payload));
  });

  return () => {
    registry.unregisterAll();
  };
}

function broadcastLoggingPreferences(preferences: LoggingPreferences): void {
  const cloned = cloneLoggingPreferences(preferences);
  for (const contents of webContents.getAllWebContents()) {
    const targetType = contents.getType?.();
    if (contents.isDestroyed()) {
      continue;
    }
    if (targetType === 'window' || targetType === 'webview') {
      try {
        contents.send(LOGGING_API_CHANNELS.preferencesUpdated, cloned);
      } catch {
        // A WebContents can disappear between enumeration and send during shutdown churn.
      }
      continue;
    }
    logger.debug('Skipping logging preference broadcast for unsupported WebContents type', {
      targetType: typeof targetType === 'string' ? targetType : 'unknown',
      webContentsId: contents.id,
    });
  }
}

export function cloneLoggingSettingsPayload(
  payload: LoggingSettingsPayload
): LoggingSettingsPayload {
  return {
    preferences: {
      ...payload.preferences,
      redactPaths: [...payload.preferences.redactPaths],
      file: { ...payload.preferences.file },
    },
    capabilities: { ...payload.capabilities },
  };
}

export function cloneLoggingPreferences(preferences: LoggingPreferences): LoggingPreferences {
  return {
    ...preferences,
    redactPaths: [...preferences.redactPaths],
    file: { ...preferences.file },
  };
}
