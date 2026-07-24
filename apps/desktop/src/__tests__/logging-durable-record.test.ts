import type { LogRecord } from '@brainstrike/utils/logger';
import {
  LogLevel,
  error as logError,
  info as logInfo,
  resetLogger,
  setLogLevel,
} from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { createDefaultLoggingPreferences } from '@brainstrike/utils/logging-preferences';
import type { IpcMainEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggingIpcHandlers } from '../logging-ipc';
import type { LoggingSettingsPayload } from '../logging-shared';
import { LOGGING_API_CHANNELS } from '../platform/logging-api-contract';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../window-role';

// ── Local Electron mock with webContents — copied verbatim from the harness
// in apps/desktop/src/__tests__/logging-ipc.test.ts ─────────────────────────
const mockAllWebContents: unknown[] = [];

const mockIpcMainHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockIpcMainListeners = new Map<string, (...args: unknown[]) => unknown>();

const mockIpcMain = {
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mockIpcMainHandlers.set(channel, handler);
  }),
  on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mockIpcMainListeners.set(channel, handler);
  }),
  removeHandler: vi.fn((channel: string) => {
    mockIpcMainHandlers.delete(channel);
  }),
  removeListener: vi.fn((channel: string, _handler: unknown) => {
    mockIpcMainListeners.delete(channel);
  }),
};

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/mock/app'),
    getName: vi.fn(() => 'Brainstrike'),
    getPath: vi.fn(() => '/mock/path'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: vi.fn(),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: mockIpcMain,
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString('utf-8')),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn(),
  },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })),
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
    },
  },
  webContents: {
    getAllWebContents: vi.fn(() => mockAllWebContents),
  },
}));

// Import after mock is set up
const { registerLoggingIpcHandlers } = await import('../logging-ipc');

// ── Helpers ─────────────────────────────────────────────────────────────
function createMockPreferences(overrides?: Partial<LoggingPreferences>): LoggingPreferences {
  return createDefaultLoggingPreferences(overrides);
}

function createMockPayload(overrides?: Partial<LoggingPreferences>): LoggingSettingsPayload {
  return {
    capabilities: {
      canSelectDestination: true,
      defaultDestination: '/tmp/test.log',
      fileLoggingSupported: true,
      runtime: 'electron',
    },
    preferences: createMockPreferences(overrides),
  };
}

function createValidLogRecord(overrides?: Partial<LogRecord>): LogRecord {
  return {
    args: ['test message'],
    bindings: { scope: 'TestScope' },
    level: LogLevel.INFO,
    message: 'test message',
    scope: 'TestScope',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockHandlers(overrides?: Partial<LoggingIpcHandlers>): LoggingIpcHandlers {
  return {
    getBufferedLogs: vi.fn(() => []),
    getState: vi.fn(() => createMockPayload()),
    ingestBufferedLog: vi.fn(),
    openDestination: vi.fn(async () => true),
    selectDestination: vi.fn(async () => '/tmp/logs'),
    setPreferences: vi.fn(async () => createMockPayload()),
    ...overrides,
  };
}

function getRegisteredListener(channel: string): (...args: unknown[]) => unknown {
  const listener = mockIpcMainListeners.get(channel);
  if (!listener) {
    throw new Error(`No ipcMain.on registration found for channel: ${channel}`);
  }
  return listener;
}

function setMockWebContents(contents: unknown[]) {
  mockAllWebContents.length = 0;
  mockAllWebContents.push(...contents);
}

function createMockWebContents(id: number) {
  return {
    getType: vi.fn(() => 'window'),
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
}

/** Minimal fake BrowserWindow satisfying window-role.ts's `assignWindowRole`
 * contract (`webContents.id` + `once('closed', ...)`), mirroring the harness
 * in apps/desktop/src/__tests__/window-role.test.ts. */
function createFakeWindow(webContents: ReturnType<typeof createMockWebContents>) {
  return {
    once: vi.fn(),
    webContents,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('durable record push', () => {
  let cleanup: (() => void) | undefined;
  let visibleContents: ReturnType<typeof createMockWebContents>;
  let hiddenContents: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcMainHandlers.clear();
    mockIpcMainListeners.clear();
    // Ensure real-logger calls made in this file always reach listeners,
    // independent of whatever ambient LOG_LEVEL the test runner has set.
    setLogLevel(LogLevel.TRACE);

    visibleContents = createMockWebContents(9101);
    hiddenContents = createMockWebContents(9102);
    setMockWebContents([visibleContents, hiddenContents]);
    assignWindowRole(createFakeWindow(visibleContents) as never, 'visible-ui');
    assignWindowRole(createFakeWindow(hiddenContents) as never, 'chunking-host');
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    clearWindowRoleByWebContentsId(9101);
    clearWindowRoleByWebContentsId(9102);
    resetLogger();
  });

  it('does not forward an INFO record ingested from a hidden host', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);
    const listener = getRegisteredListener(LOGGING_API_CHANNELS.ingestBufferedRecord);
    const mockEvent = { sender: { id: 9102 } } as unknown as IpcMainEvent;

    listener(mockEvent, createValidLogRecord({ level: LogLevel.INFO }));

    const sent = visibleContents.send.mock.calls.filter(
      ([channel]) => channel === LOGGING_API_CHANNELS.durableRecord
    );
    expect(sent).toHaveLength(0);
  });

  it('forwards an ERROR record ingested from a hidden host to the visible window exactly once', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);
    const listener = getRegisteredListener(LOGGING_API_CHANNELS.ingestBufferedRecord);
    const mockEvent = { sender: { id: 9102 } } as unknown as IpcMainEvent;

    listener(mockEvent, createValidLogRecord({ level: LogLevel.ERROR }));

    const sent = visibleContents.send.mock.calls.filter(
      ([channel]) => channel === LOGGING_API_CHANNELS.durableRecord
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toEqual(
      expect.objectContaining({
        bindings: expect.objectContaining({ sourceWindowRole: 'chunking-host' }),
        level: LogLevel.ERROR,
      })
    );
    // Design decision: hidden hosts are never push targets, even though one
    // is registered alongside the visible window in mockAllWebContents.
    expect(hiddenContents.send).not.toHaveBeenCalled();
  });

  it('forwards warn+ records observed via the main process addLogListener tap', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);

    logInfo('main info record should not be forwarded');
    logError('main error record should be forwarded');

    const sent = visibleContents.send.mock.calls.filter(
      ([channel]) => channel === LOGGING_API_CHANNELS.durableRecord
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toEqual(expect.objectContaining({ level: LogLevel.ERROR }));
  });

  it('stops pushing once the returned cleanup function is called', () => {
    const handlers = createMockHandlers();
    const registeredCleanup = registerLoggingIpcHandlers(handlers);
    registeredCleanup();

    logError('emitted after cleanup — must not be forwarded');

    const sent = visibleContents.send.mock.calls.filter(
      ([channel]) => channel === LOGGING_API_CHANNELS.durableRecord
    );
    expect(sent).toHaveLength(0);
  });

  it('every send on the durable-record channel uses the durableRecord constant', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);
    const listener = getRegisteredListener(LOGGING_API_CHANNELS.ingestBufferedRecord);
    const mockEvent = { sender: { id: 9102 } } as unknown as IpcMainEvent;

    listener(mockEvent, createValidLogRecord({ level: LogLevel.FATAL }));

    const sent = visibleContents.send.mock.calls.filter(([, record]) => {
      const candidate = record as Partial<LogRecord> | undefined;
      return candidate?.level === LogLevel.FATAL;
    });
    expect(sent.every(([channel]) => channel === LOGGING_API_CHANNELS.durableRecord)).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

// ── recordDurableLog (Flight Recorder P2a Task 3: wiring into the NDJSON
// backstop sink) — same two choke points as the durable-record push above,
// gated by the SAME `DURABLE_PUSH_LEVELS` check (no second level filter). ──
describe('recordDurableLog handler', () => {
  let cleanup: (() => void) | undefined;
  let visibleContents: ReturnType<typeof createMockWebContents>;
  let hiddenContents: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcMainHandlers.clear();
    mockIpcMainListeners.clear();
    setLogLevel(LogLevel.TRACE);

    visibleContents = createMockWebContents(9201);
    hiddenContents = createMockWebContents(9202);
    setMockWebContents([visibleContents, hiddenContents]);
    assignWindowRole(createFakeWindow(visibleContents) as never, 'visible-ui');
    assignWindowRole(createFakeWindow(hiddenContents) as never, 'chunking-host');
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    clearWindowRoleByWebContentsId(9201);
    clearWindowRoleByWebContentsId(9202);
    resetLogger();
  });

  it('is invoked for a warn+ main record observed via the addLogListener tap', () => {
    const recordDurableLog = vi.fn();
    const handlers = createMockHandlers({ recordDurableLog });
    cleanup = registerLoggingIpcHandlers(handlers);

    logInfo('main info record should not reach recordDurableLog');
    logError('main error record should reach recordDurableLog');

    expect(recordDurableLog).toHaveBeenCalledTimes(1);
    expect(recordDurableLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: LogLevel.ERROR })
    );
  });

  it('is invoked for a warn+ record ingested from a hidden host, with the sourceWindowRole binding merged in', () => {
    const recordDurableLog = vi.fn();
    const handlers = createMockHandlers({ recordDurableLog });
    cleanup = registerLoggingIpcHandlers(handlers);
    const listener = getRegisteredListener(LOGGING_API_CHANNELS.ingestBufferedRecord);
    const mockEvent = { sender: { id: 9202 } } as unknown as IpcMainEvent;

    listener(mockEvent, createValidLogRecord({ level: LogLevel.ERROR }));

    expect(recordDurableLog).toHaveBeenCalledTimes(1);
    expect(recordDurableLog).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: expect.objectContaining({ sourceWindowRole: 'chunking-host' }),
        level: LogLevel.ERROR,
      })
    );
  });

  it('is not invoked for an INFO record ingested from a hidden host', () => {
    const recordDurableLog = vi.fn();
    const handlers = createMockHandlers({ recordDurableLog });
    cleanup = registerLoggingIpcHandlers(handlers);
    const listener = getRegisteredListener(LOGGING_API_CHANNELS.ingestBufferedRecord);
    const mockEvent = { sender: { id: 9202 } } as unknown as IpcMainEvent;

    listener(mockEvent, createValidLogRecord({ level: LogLevel.INFO }));

    expect(recordDurableLog).not.toHaveBeenCalled();
  });

  it('is not invoked once the returned cleanup function is called', () => {
    const recordDurableLog = vi.fn();
    const handlers = createMockHandlers({ recordDurableLog });
    const registeredCleanup = registerLoggingIpcHandlers(handlers);
    registeredCleanup();

    logError('emitted after cleanup — must not reach recordDurableLog');

    expect(recordDurableLog).not.toHaveBeenCalled();
  });
});
