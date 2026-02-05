import type { LoggingPreferences } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  webContents: {
    getAllWebContents: vi.fn(),
  },
}));

import { ipcMain, webContents } from 'electron';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  registerLoggingIpcHandlers,
} from '../../logging-ipc';

describe('logging-ipc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePreferences: LoggingPreferences = {
    level: 'info',
    redactPaths: ['token'],
    file: {
      enabled: true,
      directory: '/tmp/logs',
    },
  };

  it('registers all logging IPC handlers', () => {
    const handlers = {
      getState: () => ({
        preferences: basePreferences,
        capabilities: { canOpenDestination: true },
      }),
      setPreferences: (prefs: LoggingPreferences) => ({
        preferences: prefs,
        capabilities: { canOpenDestination: true },
      }),
      selectDestination: async () => '/tmp',
      openDestination: async () => true,
      getBufferedLogs: () => [],
    };

    registerLoggingIpcHandlers(handlers);

    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:set-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:select-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:open-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-buffered-logs', expect.any(Function));
  });

  it('broadcasts updated preferences to window and webview contents', async () => {
    const handlers = {
      getState: () => ({
        preferences: basePreferences,
        capabilities: { canOpenDestination: true },
      }),
      setPreferences: (prefs: LoggingPreferences) => ({
        preferences: prefs,
        capabilities: { canOpenDestination: true },
      }),
      selectDestination: async () => '/tmp',
      openDestination: async () => true,
      getBufferedLogs: () => [],
    };

    const windowContents = { getType: () => 'window', send: vi.fn() };
    const webviewContents = { getType: () => 'webview', send: vi.fn() };
    const backgroundContents = { getType: () => 'backgroundPage', send: vi.fn() };

    vi.mocked(webContents.getAllWebContents).mockReturnValue([
      windowContents,
      webviewContents,
      backgroundContents,
    ] as unknown as Electron.WebContents[]);

    registerLoggingIpcHandlers(handlers);

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    const updated: LoggingPreferences = {
      ...basePreferences,
      level: 'debug',
      redactPaths: ['token', 'secret'],
    };

    await setPreferencesHandler({} as IpcMainInvokeEvent, updated);

    expect(windowContents.send).toHaveBeenCalledWith('logging:preferences-updated', updated);
    expect(webviewContents.send).toHaveBeenCalledWith('logging:preferences-updated', updated);
    expect(backgroundContents.send).not.toHaveBeenCalled();
  });

  it('clones logging settings payloads deeply', () => {
    const payload = {
      preferences: basePreferences,
      capabilities: { canOpenDestination: true },
    };

    const cloned = cloneLoggingSettingsPayload(payload);
    expect(cloned).toEqual(payload);
    expect(cloned.preferences).not.toBe(payload.preferences);
    expect(cloned.preferences.redactPaths).not.toBe(payload.preferences.redactPaths);
    expect(cloned.preferences.file).not.toBe(payload.preferences.file);
  });

  it('clones logging preferences deeply', () => {
    const cloned = cloneLoggingPreferences(basePreferences);
    expect(cloned).toEqual(basePreferences);
    expect(cloned.redactPaths).not.toBe(basePreferences.redactPaths);
    expect(cloned.file).not.toBe(basePreferences.file);
  });
});
