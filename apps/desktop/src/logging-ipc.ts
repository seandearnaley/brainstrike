import { createLogger, type LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import type { IpcMainEvent } from 'electron';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';
import {
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
  ipcMain.handle(LOGGING_API_CHANNELS.getPreferences, () => handlers.getState());

  let preferencesUpdateQueue: Promise<void> = Promise.resolve();

  ipcMain.handle(
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

  ipcMain.handle(LOGGING_API_CHANNELS.selectDestination, async () => handlers.selectDestination());

  ipcMain.handle(
    LOGGING_API_CHANNELS.openDestination,
    async (_event, target: unknown): Promise<boolean> =>
      handlers.openDestination(assertLoggingOpenDestinationTarget(target))
  );

  ipcMain.handle(LOGGING_API_CHANNELS.getBufferedLogs, async () => handlers.getBufferedLogs());
  const ingestBufferedRecord = (event: IpcMainEvent, payload: unknown) => {
    handlers.ingestBufferedLog(event.sender.id, assertLogRecord(payload));
  };
  ipcMain.on(LOGGING_API_CHANNELS.ingestBufferedRecord, ingestBufferedRecord);

  return () => {
    ipcMain.removeHandler(LOGGING_API_CHANNELS.getPreferences);
    ipcMain.removeHandler(LOGGING_API_CHANNELS.setPreferences);
    ipcMain.removeHandler(LOGGING_API_CHANNELS.selectDestination);
    ipcMain.removeHandler(LOGGING_API_CHANNELS.openDestination);
    ipcMain.removeHandler(LOGGING_API_CHANNELS.getBufferedLogs);
    ipcMain.removeListener(LOGGING_API_CHANNELS.ingestBufferedRecord, ingestBufferedRecord);
  };
}

function assertLogRecord(payload: unknown): LogRecord {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Buffered log record must be an object.');
  }

  const candidate = payload as Record<string, unknown>;
  if (
    candidate['level'] !== 'trace' &&
    candidate['level'] !== 'debug' &&
    candidate['level'] !== 'info' &&
    candidate['level'] !== 'warn' &&
    candidate['level'] !== 'error' &&
    candidate['level'] !== 'fatal' &&
    candidate['level'] !== 'silent'
  ) {
    throw new Error('Buffered log record has invalid level.');
  }
  if (typeof candidate['timestamp'] !== 'number' || !Number.isFinite(candidate['timestamp'])) {
    throw new Error('Buffered log record must include a finite numeric timestamp.');
  }
  if (!Array.isArray(candidate['args'])) {
    throw new Error('Buffered log record must include args array.');
  }
  if (
    !candidate['bindings'] ||
    typeof candidate['bindings'] !== 'object' ||
    Array.isArray(candidate['bindings'])
  ) {
    throw new Error('Buffered log record must include bindings object.');
  }
  if (candidate['message'] !== undefined && typeof candidate['message'] !== 'string') {
    throw new Error('Buffered log record message must be a string when present.');
  }
  if (candidate['scope'] !== undefined && typeof candidate['scope'] !== 'string') {
    throw new Error('Buffered log record scope must be a string when present.');
  }

  return {
    level: candidate['level'] as LogRecord['level'],
    timestamp: candidate['timestamp'],
    args: candidate['args'],
    bindings: candidate['bindings'] as Record<string, unknown>,
    ...(typeof candidate['message'] === 'string' ? { message: candidate['message'] } : {}),
    ...(typeof candidate['scope'] === 'string' ? { scope: candidate['scope'] } : {}),
  } satisfies LogRecord;
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
