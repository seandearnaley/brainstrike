import type { LoggingPreferences } from '@brainstrike/utils';
import { ipcMain } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';

export interface LoggingIpcHandlers {
  getState: () => LoggingSettingsPayload;
  setPreferences: (preferences: LoggingPreferences) => LoggingSettingsPayload;
  selectDestination: () => Promise<string | null>;
  openDestination: (target: string | null) => Promise<boolean>;
}

export function registerLoggingIpcHandlers(handlers: LoggingIpcHandlers): void {
  ipcMain.handle('logging:get-preferences', () => handlers.getState());

  ipcMain.handle(
    'logging:set-preferences',
    async (_event, preferences: LoggingPreferences): Promise<LoggingSettingsPayload> => {
      return handlers.setPreferences(preferences);
    }
  );

  ipcMain.handle('logging:select-destination', async () => handlers.selectDestination());

  ipcMain.handle(
    'logging:open-destination',
    async (_event, target: string | null): Promise<boolean> => handlers.openDestination(target)
  );
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
