import type { LoggingPreferences, LogRecord } from '@brainstrike/utils';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';

export interface LoggingIpcHandlers {
  getState: () => LoggingSettingsPayload;
  setPreferences: (preferences: LoggingPreferences) => LoggingSettingsPayload;
  selectDestination: () => Promise<string | null>;
  openDestination: (target: string | null) => Promise<boolean>;
  getBufferedLogs: () => readonly LogRecord[];
}

export function registerLoggingIpcHandlers(handlers: LoggingIpcHandlers): void {
  ipcMain.handle('logging:get-preferences', () => handlers.getState());

  ipcMain.handle(
    'logging:set-preferences',
    async (_event, preferences: LoggingPreferences): Promise<LoggingSettingsPayload> => {
      const payload = handlers.setPreferences(preferences);
      broadcastLoggingPreferences(payload.preferences);
      return payload;
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
