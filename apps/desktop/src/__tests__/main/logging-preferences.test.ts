import { type LoggingPreferences, LogLevel } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';

const { applyLoggingPreferencesMock } = vi.hoisted(() => ({
  applyLoggingPreferencesMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return { ...actual, applyLoggingPreferences: applyLoggingPreferencesMock };
});

const { accessSyncMock, statSyncMock } = vi.hoisted(() => ({
  accessSyncMock: vi.fn(),
  statSyncMock: vi.fn((): { isDirectory: () => boolean } => ({ isDirectory: () => true })),
}));
vi.mock('node:fs', () => ({
  default: {
    accessSync: accessSyncMock,
    constants: { W_OK: 0o200 },
    promises: {
      access: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ isDirectory: () => true, mtimeMs: 1, size: 1 })),
    },
    statSync: statSyncMock,
  },
}));

import {
  createDesktopLoggingPreferencesController,
  readConsoleLevelOverride,
} from '../../main/logging-preferences';

function createStore(initial?: { v1: LoggingPreferences }) {
  const records = new Map<string, unknown>();
  if (initial) {
    records.set('loggingPreferences', initial);
  }
  return {
    get: vi.fn((key: string) => records.get(key)),
    records,
    set: vi.fn((key: string, value: unknown) => {
      records.set(key, value);
    }),
  };
}

function createController(options: {
  consoleLevelOverride?: LogLevel;
  disableFileLogs?: boolean;
  logFilePath?: string | null;
  store?: ReturnType<typeof createStore> | null;
}) {
  const store = options.store === undefined ? createStore() : options.store;
  const onFilePreferencesApplied = vi.fn();
  const controller = createDesktopLoggingPreferencesController({
    app: {
      getPath: vi.fn(() => '/mock/logs'),
      getVersion: vi.fn(() => '0.0.0-test'),
      isReady: vi.fn(() => true),
    },
    consoleLevelOverride: options.consoleLevelOverride,
    createMainLogTransportConfig: () => ({ options: { maxBytes: 1, maxFiles: 1 }, target: '/t' }),
    disableFileLogs: options.disableFileLogs ?? false,
    getLogFilePath: () => options.logFilePath ?? '/mock/logs/brainstrike.log',
    getSettingsStore: () => store as never,
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
    onFilePreferencesApplied,
    showItemInFolder: vi.fn(),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
  });
  return { controller, onFilePreferencesApplied, store };
}

describe('createDesktopLoggingPreferencesController', () => {
  it('resolves desktop defaults (info persistent logs, warn renderer console) when nothing is stored', () => {
    const { controller } = createController({ store: null });
    expect(controller.initial).toMatchObject({
      consoleLevel: LogLevel.WARN,
      file: { destination: '/mock/logs/brainstrike.log', enabled: true, level: LogLevel.INFO },
      level: LogLevel.INFO,
    });
  });

  it('migrates the legacy debug-everything defaults back to the current defaults', () => {
    const legacy = createController({ store: null }).controller.initial;
    const stored = createStore({
      v1: {
        ...legacy,
        consoleLevel: LogLevel.INFO,
        file: { ...legacy.file, level: LogLevel.DEBUG },
        level: LogLevel.DEBUG,
      },
    });
    const { controller } = createController({ store: stored });
    expect(controller.initial.level).toBe(LogLevel.INFO);
    expect(controller.initial.file.level).toBe(LogLevel.INFO);
    expect(controller.initial.consoleLevel).toBe(LogLevel.WARN);
  });

  it('keeps a genuinely customized stored preference set', () => {
    const base = createController({ store: null }).controller.initial;
    const stored = createStore({
      v1: { ...base, level: LogLevel.TRACE, redactPaths: [' a ', ''] },
    });
    const { controller } = createController({ store: stored });
    expect(controller.initial.level).toBe(LogLevel.TRACE);
    expect(controller.initial.redactPaths).toEqual(['a']);
  });

  it('forces file logging off under BRAINSTRIKE_DISABLE_FILE_LOGS and reports the capability', () => {
    const { controller } = createController({ disableFileLogs: true, logFilePath: null });
    expect(controller.initial.file).toMatchObject({ destination: null, enabled: false });
    expect(controller.getSettingsPayload().capabilities).toMatchObject({
      canSelectDestination: false,
      fileLoggingSupported: false,
      reason: 'File logging disabled by BRAINSTRIKE_DISABLE_FILE_LOGS=1',
    });
    expect(controller.enableFileLoggingAfterReady()).toBeNull();
  });

  it('applies + persists an update, notifies the watchdog hook, and exposes the new current set', async () => {
    const { controller, onFilePreferencesApplied, store } = createController({});
    controller.applyInitial();
    expect(store?.set).toHaveBeenCalledTimes(1);

    const payload = await controller.applyAndPersist({
      ...controller.current,
      level: LogLevel.DEBUG,
    });

    expect(payload.preferences.level).toBe(LogLevel.DEBUG);
    expect(controller.current.level).toBe(LogLevel.DEBUG);
    expect(store?.set).toHaveBeenCalledTimes(2);
    expect(onFilePreferencesApplied).toHaveBeenCalledWith(controller.current.file);
    expect(applyLoggingPreferencesMock).toHaveBeenLastCalledWith(
      controller.current,
      'electron-main',
      expect.objectContaining({ baseBindings: { logFile: '/mock/logs/brainstrike.log' } })
    );
  });

  it('applies LOG_LEVEL as the terminal threshold without persisting or reporting it (BST-2036)', async () => {
    const { controller, store } = createController({ consoleLevelOverride: LogLevel.INFO });
    expect(controller.createInitializeLoggingOptions()).toMatchObject({
      consoleLevel: LogLevel.INFO,
      level: LogLevel.INFO,
    });
    controller.applyInitial();
    expect(applyLoggingPreferencesMock).toHaveBeenLastCalledWith(
      { ...controller.current, consoleLevel: LogLevel.INFO },
      'electron-main',
      expect.anything()
    );
    expect(store?.records.get('loggingPreferences')).toMatchObject({
      v1: { consoleLevel: LogLevel.WARN },
    });
    expect(controller.getSettingsPayload().preferences.consoleLevel).toBe(LogLevel.WARN);

    // A saved update keeps the override on top; a more verbose override also lowers the logger.
    const debug = createController({ consoleLevelOverride: LogLevel.DEBUG }).controller;
    await debug.applyAndPersist({ ...debug.current, consoleLevel: LogLevel.ERROR });
    expect(debug.current.consoleLevel).toBe(LogLevel.ERROR);
    expect(applyLoggingPreferencesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ consoleLevel: LogLevel.DEBUG, level: LogLevel.DEBUG }),
      'electron-main',
      expect.anything()
    );
  });

  it('keeps the saved threshold without an override', () => {
    const { controller } = createController({});
    expect(controller.createInitializeLoggingOptions()).toMatchObject({
      consoleLevel: LogLevel.WARN,
      level: LogLevel.INFO,
    });
  });

  it('reads LOG_LEVEL as a known level name, case-insensitively', () => {
    expect(readConsoleLevelOverride('info')).toBe(LogLevel.INFO);
    expect(readConsoleLevelOverride(' WARN ')).toBe(LogLevel.WARN);
    expect(readConsoleLevelOverride('silent')).toBe(LogLevel.SILENT);
    expect(readConsoleLevelOverride('verbose')).toBeUndefined();
    expect(readConsoleLevelOverride('')).toBeUndefined();
    expect(readConsoleLevelOverride(undefined)).toBeUndefined();
  });

  it('does not mutate the current set when persistence is unavailable', async () => {
    const { controller, store } = createController({});
    const before = controller.current;
    store?.set.mockImplementation(() => {
      throw new Error('disk full');
    });
    const payload = await controller.applyAndPersist({ ...before, level: LogLevel.DEBUG });
    expect(controller.current).toBe(before);
    expect(payload.preferences.level).toBe(before.level);
  });

  it('enables file logging after app.ready when it was disabled only because no path was known', () => {
    let ready = false;
    const store = createStore();
    const controller = createDesktopLoggingPreferencesController({
      app: {
        getPath: vi.fn(() => '/mock/logs'),
        getVersion: vi.fn(() => '0.0.0-test'),
        isReady: vi.fn(() => ready),
      },
      createMainLogTransportConfig: () => ({ options: { maxBytes: 1, maxFiles: 1 }, target: '/t' }),
      disableFileLogs: false,
      getLogFilePath: () => (ready ? '/mock/logs/brainstrike.log' : null),
      getSettingsStore: () => store as never,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      onFilePreferencesApplied: vi.fn(),
      showItemInFolder: vi.fn(),
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
    });
    expect(controller.initial.file.enabled).toBe(false);
    ready = true;
    expect(controller.enableFileLoggingAfterReady()).toBe('/mock/logs/brainstrike.log');
    expect(controller.current.file).toMatchObject({
      destination: '/mock/logs/brainstrike.log',
      enabled: true,
    });
    expect(applyLoggingPreferencesMock).toHaveBeenLastCalledWith(
      controller.current,
      'electron-main',
      expect.objectContaining({
        baseBindings: expect.objectContaining({ logFile: '/mock/logs/brainstrike.log' }),
      })
    );
  });
});
