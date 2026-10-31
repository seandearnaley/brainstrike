import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
import {
  createDefaultLoggingPreferences,
  LogLevel,
  error as logError,
  fatal as logFatal,
  info as logInfo,
  resetLogger,
  setLogLevel,
} from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackAppWindow, untrackAppWindow } from '../app-windows';
import type { LoggingIpcHandlers } from '../logging-ipc';
import type { LoggingSettingsPayload } from '../logging-shared';
import { DESKTOP_IPC_PUSH_CHANNEL, type DesktopIpcPush } from '../platform/desktop-ipc-channels';
import { LOGGING_API_CHANNELS } from '../platform/logging-api-contract';
import {
  resetElectronMainTestHarness,
  setMockWebContents,
} from './helpers/electron-main-test-harness';

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
    defaults: createMockPreferences(),
    preferences: createMockPreferences(overrides),
  };
}

function createMockHandlers(overrides?: Partial<LoggingIpcHandlers>): LoggingIpcHandlers {
  return {
    getBufferedLogs: vi.fn(() => []),
    getState: vi.fn(() => createMockPayload()),
    openDestination: vi.fn(async () => true),
    selectDestination: vi.fn(async () => '/tmp/logs'),
    setPreferences: vi.fn(async () => createMockPayload()),
    ...overrides,
  };
}

function createMockWebContents(id: number) {
  return {
    getType: vi.fn(() => 'window'),
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn<(channel: string, push: DesktopIpcPush) => void>(),
  };
}

/** The durable records pushed to `contents`, in order. */
function durablePushes(contents: ReturnType<typeof createMockWebContents>): unknown[] {
  return contents.send.mock.calls
    .filter(
      ([channel, push]) =>
        channel === DESKTOP_IPC_PUSH_CHANNEL && push.method === LOGGING_API_CHANNELS.durableRecord
    )
    .map(([, push]) => push.payload);
}

/** BrowserWindow fixture for app window tracking. */
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
  let untrackedContents: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    resetElectronMainTestHarness();
    // Ensure real-logger calls made in this file always reach listeners,
    // independent of whatever ambient LOG_LEVEL the test runner has set.
    setLogLevel(LogLevel.TRACE);

    visibleContents = createMockWebContents(9101);
    untrackedContents = createMockWebContents(9102);
    setMockWebContents([visibleContents, untrackedContents]);
    trackAppWindow(createFakeWindow(visibleContents) as never);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    untrackAppWindow(9101);
    resetLogger();
  });

  it('forwards warn+ records observed via the main process addLogListener tap', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);

    logInfo('main info record should not be forwarded');
    logError('main error record should be forwarded');

    const sent = durablePushes(visibleContents);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(expect.objectContaining({ level: LogLevel.ERROR }));
    // Design decision: only app windows are push targets, even though an
    // untracked webContents is listed alongside the visible window.
    expect(untrackedContents.send).not.toHaveBeenCalled();
  });

  it('stops pushing once the returned cleanup function is called', () => {
    const handlers = createMockHandlers();
    const registeredCleanup = registerLoggingIpcHandlers(handlers);
    registeredCleanup();

    logError('emitted after cleanup — must not be forwarded');

    expect(durablePushes(visibleContents)).toHaveLength(0);
  });

  it('every push of a warn+ record uses the durableRecord method', () => {
    const handlers = createMockHandlers();
    cleanup = registerLoggingIpcHandlers(handlers);

    logFatal('main fatal record should be forwarded');

    const sent = visibleContents.send.mock.calls.filter(([, push]) => {
      const candidate = push.payload as Partial<LogRecord> | undefined;
      return candidate?.level === LogLevel.FATAL;
    });
    expect(
      sent.every(
        ([channel, push]) =>
          channel === DESKTOP_IPC_PUSH_CHANNEL && push.method === LOGGING_API_CHANNELS.durableRecord
      )
    ).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

// ── recordDurableLog (Flight Recorder P2a Task 3: wiring into the NDJSON
// backstop sink) — the same choke point as the durable-record push above,
// gated by the SAME `DURABLE_PUSH_LEVELS` check (no second level filter). ──
describe('recordDurableLog handler', () => {
  let cleanup: (() => void) | undefined;
  let visibleContents: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    resetElectronMainTestHarness();
    setLogLevel(LogLevel.TRACE);

    visibleContents = createMockWebContents(9201);
    setMockWebContents([visibleContents]);
    trackAppWindow(createFakeWindow(visibleContents) as never);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    untrackAppWindow(9201);
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

  it('is not invoked once the returned cleanup function is called', () => {
    const recordDurableLog = vi.fn();
    const handlers = createMockHandlers({ recordDurableLog });
    const registeredCleanup = registerLoggingIpcHandlers(handlers);
    registeredCleanup();

    logError('emitted after cleanup — must not reach recordDurableLog');

    expect(recordDurableLog).not.toHaveBeenCalled();
  });
});
