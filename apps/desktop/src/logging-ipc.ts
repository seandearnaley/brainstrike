import { createLogger, type LoggingPreferences, type LogRecord } from '@brainstrike/utils';
import type { IpcMainEvent } from 'electron';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';

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
  ipcMain.handle('logging:get-preferences', () => handlers.getState());

  let preferencesUpdateQueue: Promise<void> = Promise.resolve();

  ipcMain.handle(
    'logging:set-preferences',
    async (_event, preferences: LoggingPreferences): Promise<LoggingSettingsPayload> => {
      const runUpdate = async (): Promise<LoggingSettingsPayload> => {
        const payload = await handlers.setPreferences(preferences);
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

  ipcMain.handle('logging:select-destination', async () => handlers.selectDestination());

  ipcMain.handle(
    'logging:open-destination',
    async (_event, target: string | null): Promise<boolean> => handlers.openDestination(target)
  );

  ipcMain.handle('logging:get-buffered-logs', async () => handlers.getBufferedLogs());
  const ingestBufferedRecord = (event: IpcMainEvent, payload: unknown) => {
    handlers.ingestBufferedLog(event.sender.id, assertLogRecord(payload));
  };
  ipcMain.on('logging:ingest-buffered-record', ingestBufferedRecord);

  return () => {
    ipcMain.removeHandler('logging:get-preferences');
    ipcMain.removeHandler('logging:set-preferences');
    ipcMain.removeHandler('logging:select-destination');
    ipcMain.removeHandler('logging:open-destination');
    ipcMain.removeHandler('logging:get-buffered-logs');
    ipcMain.removeListener('logging:ingest-buffered-record', ingestBufferedRecord);
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
        contents.send('logging:preferences-updated', cloned);
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
