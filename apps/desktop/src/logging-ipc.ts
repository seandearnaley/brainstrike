import type { LoggingPreferences, LogRecord } from '@brainstrike/utils';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';

export interface LoggingIpcHandlers {
  getBufferedLogs: () => readonly LogRecord[];
  getState: () => LoggingSettingsPayload;
  openDestination: (target: string | null) => Promise<boolean>;
  selectDestination: () => Promise<string | null>;
  setPreferences: (
    preferences: LoggingPreferences
  ) => LoggingSettingsPayload | Promise<LoggingSettingsPayload>;
}

export function registerLoggingIpcHandlers(handlers: LoggingIpcHandlers): void {
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
}

function broadcastLoggingPreferences(preferences: LoggingPreferences): void {
  const cloned = cloneLoggingPreferences(preferences);
  for (const contents of webContents.getAllWebContents()) {
    const targetType = contents.getType?.();
    if (targetType === 'window' || targetType === 'webview' || !targetType) {
      contents.send('logging:preferences-updated', cloned);
    }
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
