import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  type LoggingIpcHandlers,
  registerLoggingIpcHandlers,
} from '../../logging-ipc';
import type { LoggingSettingsPayload } from '../../logging-shared';
import {
  resetElectronMainTestHarness,
  setMockWebContents,
} from '../helpers/electron-main-test-harness';

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

describe('logging-ipc', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  const basePreferences: LoggingPreferences = createDefaultLoggingPreferences({
    file: {
      append: true,
      destination: '/tmp/logs',
      enabled: true,
      level: LogLevel.INFO,
      mkdir: true,
    },
    redactPaths: ['token'],
  });

  it('registers all logging IPC handlers', () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: { canOpenDestination: true },
        preferences: prefs,
      }),
    };

    registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:set-preferences', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:select-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:open-destination', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('logging:get-buffered-logs', expect.any(Function));
    expect(ipcMain.on).toHaveBeenCalledWith('logging:ingest-buffered-record', expect.any(Function));
  });

  it('returns a cleanup function that unregisters logging handlers', () => {
    const cleanup = registerLoggingIpcHandlers({
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: prefs,
      }),
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
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: { canOpenDestination: true },
        preferences: prefs,
      }),
    };

    const windowContents = { getType: () => 'window', isDestroyed: () => false, send: vi.fn() };
    const webviewContents = { getType: () => 'webview', isDestroyed: () => false, send: vi.fn() };
    const backgroundContents = {
      getType: () => 'backgroundPage',
      isDestroyed: () => false,
      send: vi.fn(),
    };

    setMockWebContents([windowContents, webviewContents, backgroundContents]);

    registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    const updated: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.DEBUG,
      redactPaths: ['token', 'secret'],
    };

    await setPreferencesHandler({} as IpcMainInvokeEvent, updated);

    expect(windowContents.send).toHaveBeenCalledWith('logging:preferences-updated', updated);
    expect(webviewContents.send).toHaveBeenCalledWith('logging:preferences-updated', updated);
    expect(backgroundContents.send).not.toHaveBeenCalled();
  });

  it('skips destroyed contents when broadcasting updated preferences', async () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: { canOpenDestination: true },
        preferences: prefs,
      }),
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

    setMockWebContents([destroyedContents, liveContents]);

    registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

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
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: { canOpenDestination: true },
        preferences: prefs,
      }),
    };

    const workerContents = {
      getType: () => 'service-worker',
      id: 42,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const liveContents = {
      getType: () => 'window',
      id: 43,
      isDestroyed: () => false,
      send: vi.fn(),
    };

    setMockWebContents([workerContents, liveContents]);

    registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

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
      capabilities: { canOpenDestination: true },
      preferences: basePreferences,
    };

    const cloned = cloneLoggingSettingsPayload(payload as unknown as LoggingSettingsPayload);
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
    const firstDeferred = createDeferred<LoggingSettingsPayload>();
    const setPreferences = vi
      .fn<(_preferences: LoggingPreferences) => Promise<LoggingSettingsPayload>>()
      .mockImplementationOnce(async (preferences: LoggingPreferences) => {
        const payload = await firstDeferred.promise;
        return { ...payload, preferences };
      })
      .mockImplementation(async (preferences: LoggingPreferences) => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences,
      }));

    registerLoggingIpcHandlers({
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: basePreferences,
      }),
      ingestBufferedLog: vi.fn(),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences,
    });

    const setPreferencesHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'logging:set-preferences')?.[1] as (
      event: IpcMainInvokeEvent,
      preferences: LoggingPreferences
    ) => Promise<unknown>;

    const firstPreferences: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.DEBUG,
    };
    const secondPreferences: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.WARN,
    };

    const firstCall = setPreferencesHandler({} as IpcMainInvokeEvent, firstPreferences);
    const secondCall = setPreferencesHandler({} as IpcMainInvokeEvent, secondPreferences);

    await Promise.resolve();
    expect(setPreferences).toHaveBeenCalledTimes(1);

    firstDeferred.resolve({
      capabilities: {
        canOpenDestination: true,
      } as unknown as LoggingSettingsPayload['capabilities'],
      preferences: firstPreferences,
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
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: basePreferences,
      }),
      ingestBufferedLog,
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: prefs,
      }),
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
        args: ['forwarded', { ok: true }],
        bindings: { runtime: 'electron-renderer' },
        level: 'info',
        message: 'forwarded',
        scope: 'ChunkingHostRuntime',
        timestamp: 123,
      }
    );

    expect(ingestBufferedLog).toHaveBeenCalledWith(42, {
      args: ['forwarded', { ok: true }],
      bindings: { runtime: 'electron-renderer' },
      level: 'info',
      message: 'forwarded',
      scope: 'ChunkingHostRuntime',
      timestamp: 123,
    });
  });
});
