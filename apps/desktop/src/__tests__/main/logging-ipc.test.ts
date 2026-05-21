import { createDefaultLoggingPreferences, type LoggingPreferences } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
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

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe('logging-ipc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePreferences: LoggingPreferences = createDefaultLoggingPreferences({
    redactPaths: ['token'],
    file: {
      append: true,
      destination: '/tmp/logs',
      enabled: true,
      level: 'info',
      mkdir: true,
    },
  });

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
      ingestBufferedLog: vi.fn(),
    };

    registerLoggingIpcHandlers(handlers);

    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:set-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:select-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:open-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-buffered-logs', expect.any(Function));
    expect(ipcMain.on).toHaveBeenCalledWith('logging:ingest-buffered-record', expect.any(Function));
  });

  it('returns a cleanup function that unregisters logging handlers', () => {
    const cleanup = registerLoggingIpcHandlers({
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
      ingestBufferedLog: vi.fn(),
    });

    cleanup();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('logging:get-preferences');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('logging:set-preferences');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('logging:select-destination');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('logging:open-destination');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('logging:get-buffered-logs');
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'logging:ingest-buffered-record',
      expect.any(Function)
    );
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
      ingestBufferedLog: vi.fn(),
    };

    const windowContents = { getType: () => 'window', isDestroyed: () => false, send: vi.fn() };
    const webviewContents = { getType: () => 'webview', isDestroyed: () => false, send: vi.fn() };
    const backgroundContents = {
      getType: () => 'backgroundPage',
      isDestroyed: () => false,
      send: vi.fn(),
    };

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

  it('skips destroyed contents when broadcasting updated preferences', async () => {
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
      ingestBufferedLog: vi.fn(),
    };

    const destroyedContents = {
      getType: () => 'window',
      isDestroyed: () => true,
      send: vi.fn(),
    };
    const liveContents = {
      getType: () => 'window',
      isDestroyed: () => false,
      send: vi.fn(),
    };

    vi.mocked(webContents.getAllWebContents).mockReturnValue([
      destroyedContents,
      liveContents,
    ] as unknown as Electron.WebContents[]);

    registerLoggingIpcHandlers(handlers);

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    await setPreferencesHandler({} as IpcMainInvokeEvent, basePreferences);

    expect(destroyedContents.send).not.toHaveBeenCalled();
    expect(liveContents.send).toHaveBeenCalledWith('logging:preferences-updated', basePreferences);
  });

  it('skips unsupported WebContents types when broadcasting updated preferences', async () => {
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
      ingestBufferedLog: vi.fn(),
    };

    const workerContents = {
      id: 42,
      getType: () => 'service-worker',
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const liveContents = {
      id: 43,
      getType: () => 'window',
      isDestroyed: () => false,
      send: vi.fn(),
    };

    vi.mocked(webContents.getAllWebContents).mockReturnValue([
      workerContents,
      liveContents,
    ] as unknown as Electron.WebContents[]);

    registerLoggingIpcHandlers(handlers);

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    await setPreferencesHandler({} as IpcMainInvokeEvent, basePreferences);

    expect(workerContents.send).not.toHaveBeenCalled();
    expect(liveContents.send).toHaveBeenCalledWith('logging:preferences-updated', basePreferences);
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

  it('serializes async logging preference updates to preserve call order', async () => {
    const firstDeferred = createDeferred<{
      preferences: LoggingPreferences;
      capabilities: { canOpenDestination: boolean };
    }>();
    const setPreferences = vi
      .fn<
        (_preferences: LoggingPreferences) => Promise<{
          preferences: LoggingPreferences;
          capabilities: { canOpenDestination: boolean };
        }>
      >()
      .mockImplementationOnce(async (preferences: LoggingPreferences) => {
        const payload = await firstDeferred.promise;
        return { ...payload, preferences };
      })
      .mockImplementation(async (preferences: LoggingPreferences) => ({
        preferences,
        capabilities: { canOpenDestination: true },
      }));

    registerLoggingIpcHandlers({
      getState: () => ({
        preferences: basePreferences,
        capabilities: { canOpenDestination: true },
      }),
      setPreferences,
      selectDestination: async () => '/tmp',
      openDestination: async () => true,
      getBufferedLogs: () => [],
      ingestBufferedLog: vi.fn(),
    });

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    const firstPreferences: LoggingPreferences = {
      ...basePreferences,
      level: 'debug',
    };
    const secondPreferences: LoggingPreferences = {
      ...basePreferences,
      level: 'warn',
    };

    const firstCall = setPreferencesHandler({} as IpcMainInvokeEvent, firstPreferences);
    const secondCall = setPreferencesHandler({} as IpcMainInvokeEvent, secondPreferences);

    await Promise.resolve();
    expect(setPreferences).toHaveBeenCalledTimes(1);

    firstDeferred.resolve({
      preferences: firstPreferences,
      capabilities: { canOpenDestination: true },
    });
    await firstCall;
    await secondCall;

    expect(setPreferences).toHaveBeenCalledTimes(2);
    expect(setPreferences.mock.calls[0]?.[0]).toEqual(firstPreferences);
    expect(setPreferences.mock.calls[1]?.[0]).toEqual(secondPreferences);
  });

  it('forwards strict buffered log records to the supplied ingest handler', () => {
    const ingestBufferedLog = vi.fn();

    registerLoggingIpcHandlers({
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
      ingestBufferedLog,
    });

    const ingestHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'logging:ingest-buffered-record')?.[1] as (
      event: { sender: { id: number } },
      record: unknown
    ) => void;

    ingestHandler(
      { sender: { id: 42 } },
      {
        level: 'info',
        timestamp: 123,
        args: ['forwarded', { ok: true }],
        bindings: { runtime: 'electron-renderer' },
        message: 'forwarded',
        scope: 'ChunkingHostRuntime',
      }
    );

    expect(ingestBufferedLog).toHaveBeenCalledWith(42, {
      level: 'info',
      timestamp: 123,
      args: ['forwarded', { ok: true }],
      bindings: { runtime: 'electron-renderer' },
      message: 'forwarded',
      scope: 'ChunkingHostRuntime',
    });
  });
});
