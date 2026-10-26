import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  type LoggingIpcHandlers,
  registerLoggingIpcHandlers,
} from '../../logging-ipc';
import type { LoggingSettingsPayload } from '../../logging-shared';
import { DESKTOP_IPC_PUSH_CHANNEL } from '../../platform/desktop-ipc-channels';
import { invokeDesktopIpc } from '../helpers/desktop-ipc-sender-test-helpers';
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

const LOGGING_METHODS = [
  'logging:get-preferences',
  'logging:set-preferences',
  'logging:select-destination',
  'logging:open-destination',
  'logging:get-buffered-logs',
] as const;

function setPreferencesOverIpc(preferences: LoggingPreferences): Promise<unknown> {
  return invokeDesktopIpc(ipcMain, 'logging:set-preferences', preferences);
}

describe('logging-ipc', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
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

  it('registers all logging IPC handlers', async () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences: (prefs: LoggingPreferences) => ({
        capabilities: { canOpenDestination: true },
        preferences: prefs,
      }),
    };

    cleanup = registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    await expect(invokeDesktopIpc(ipcMain, 'logging:get-preferences')).resolves.toMatchObject({
      ok: true,
    });
    await expect(setPreferencesOverIpc(basePreferences)).resolves.toMatchObject({ ok: true });
    await expect(invokeDesktopIpc(ipcMain, 'logging:select-destination')).resolves.toEqual({
      ok: true,
      value: '/tmp',
    });
    await expect(invokeDesktopIpc(ipcMain, 'logging:open-destination', '/tmp')).resolves.toEqual({
      ok: true,
      value: true,
    });
    await expect(invokeDesktopIpc(ipcMain, 'logging:get-buffered-logs')).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it('returns a cleanup function that unregisters logging handlers', async () => {
    cleanup = registerLoggingIpcHandlers({
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: basePreferences,
      }),
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

    for (const method of LOGGING_METHODS) {
      await expect(invokeDesktopIpc(ipcMain, method)).rejects.toThrow(
        `No desktop IPC handler for ${method}.`
      );
    }
  });

  it('broadcasts updated preferences to window and webview contents', async () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
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

    cleanup = registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    const updated: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.DEBUG,
      redactPaths: ['token', 'secret'],
    };

    await setPreferencesOverIpc(updated);

    expect(windowContents.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: 'logging:preferences-updated',
      payload: updated,
    });
    expect(webviewContents.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: 'logging:preferences-updated',
      payload: updated,
    });
    expect(backgroundContents.send).not.toHaveBeenCalled();
  });

  it('skips destroyed contents when broadcasting updated preferences', async () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
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

    cleanup = registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    await setPreferencesOverIpc(basePreferences);

    expect(destroyedContents.send).not.toHaveBeenCalled();
    expect(liveContents.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: 'logging:preferences-updated',
      payload: basePreferences,
    });
  });

  it('skips unsupported WebContents types when broadcasting updated preferences', async () => {
    const handlers = {
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: { canOpenDestination: true },
        preferences: basePreferences,
      }),
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

    cleanup = registerLoggingIpcHandlers(handlers as unknown as LoggingIpcHandlers);

    await setPreferencesOverIpc(basePreferences);

    expect(workerContents.send).not.toHaveBeenCalled();
    expect(liveContents.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: 'logging:preferences-updated',
      payload: basePreferences,
    });
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

    cleanup = registerLoggingIpcHandlers({
      getBufferedLogs: () => [],
      getState: () => ({
        capabilities: {
          canOpenDestination: true,
        } as unknown as LoggingSettingsPayload['capabilities'],
        preferences: basePreferences,
      }),
      openDestination: async () => true,
      selectDestination: async () => '/tmp',
      setPreferences,
    });

    const firstPreferences: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.DEBUG,
    };
    const secondPreferences: LoggingPreferences = {
      ...basePreferences,
      level: LogLevel.WARN,
    };

    const firstCall = setPreferencesOverIpc(firstPreferences);
    const secondCall = setPreferencesOverIpc(secondPreferences);

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
});
