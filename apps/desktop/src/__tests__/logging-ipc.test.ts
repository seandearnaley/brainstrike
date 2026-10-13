import { INTERNAL_FAULT, refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
import { createDefaultLoggingPreferences, LogLevel } from '@brainstrike/logging';
import type { IpcMainEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggingIpcHandlers } from '../logging-ipc';
import type { LoggingSettingsPayload } from '../logging-shared';
import {
  getRegisteredIpcMainHandler,
  getRegisteredIpcMainListener,
  mockIpcMain,
  resetElectronMainTestHarness,
  setMockWebContents,
} from './helpers/electron-main-test-harness';

// Import after mock is set up
const { cloneLoggingPreferences, cloneLoggingSettingsPayload, registerLoggingIpcHandlers } =
  await import('../logging-ipc');

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

// ── Tests ───────────────────────────────────────────────────────────────
describe('logging-ipc', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  // ── registerLoggingIpcHandlers ──────────────────────────────────────
  describe('registerLoggingIpcHandlers', () => {
    let cleanup: () => void;

    afterEach(() => {
      cleanup?.();
    });

    it('registers all expected IPC channels', () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handleChannels = (mockIpcMain.handle.mock.calls as [string, unknown][]).map(
        ([ch]) => ch
      );

      expect(handleChannels).toContain('logging:get-preferences');
      expect(handleChannels).toContain('logging:set-preferences');
      expect(handleChannels).toContain('logging:select-destination');
      expect(handleChannels).toContain('logging:open-destination');
      expect(handleChannels).toContain('logging:get-buffered-logs');

      const onChannels = (mockIpcMain.on.mock.calls as [string, unknown][]).map(([ch]) => ch);

      expect(onChannels).toContain('logging:ingest-buffered-record');
    });

    it('get-preferences handler delegates to getState', async () => {
      const payload = createMockPayload();
      const handlers = createMockHandlers({
        getState: vi.fn(() => payload),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:get-preferences');
      const result = await handler();

      expect(handlers.getState).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: payload });
    });

    it('set-preferences handler delegates to setPreferences and broadcasts', async () => {
      const prefs = createMockPreferences({ consoleEnabled: false });
      const payload = createMockPayload({ consoleEnabled: false });

      const mockContent = {
        getType: vi.fn(() => 'window'),
        id: 1,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers({
        setPreferences: vi.fn(async () => payload),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      const result = await handler({}, prefs);

      expect(handlers.setPreferences).toHaveBeenCalledWith(prefs);
      expect(result).toEqual({ ok: true, value: payload });
      expect(mockContent.send).toHaveBeenCalledWith(
        'logging:preferences-updated',
        expect.objectContaining({ consoleEnabled: false })
      );
    });

    it('set-preferences handler serialises concurrent updates', async () => {
      const callOrder: number[] = [];

      const handlers = createMockHandlers({
        setPreferences: vi.fn(async (prefs: LoggingPreferences) => {
          // Simulate async work
          await new Promise((r) => setTimeout(r, 5));
          callOrder.push(prefs.consoleEnabled ? 1 : 2);
          return createMockPayload(prefs);
        }),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');

      // Fire two updates concurrently
      const first = handler({}, createMockPreferences({ consoleEnabled: true }));
      const second = handler({}, createMockPreferences({ consoleEnabled: false }));

      await Promise.all([first, second]);

      // Both should have completed
      expect(callOrder).toHaveLength(2);
    });

    it('set-preferences queue recovers from a rejection', async () => {
      let callCount = 0;
      const handlers = createMockHandlers({
        setPreferences: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('transient failure');
          }
          return createMockPayload();
        }),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');

      // First call rejects
      await expect(handler({}, createMockPreferences())).resolves.toMatchObject({
        error: INTERNAL_FAULT,
        ok: false,
      });

      // Second call should still work (queue recovered)
      const result = await handler({}, createMockPreferences());
      expect(result).toBeDefined();
    });

    it('settles an owned refusal as plain typed data with its remedy', async () => {
      const refusal = refusalError(
        'configuration',
        'logging.destination-unavailable',
        'The destination is unavailable.',
        'Choose another destination.'
      );
      cleanup = registerLoggingIpcHandlers(
        createMockHandlers({
          selectDestination: async () => {
            throw refusal;
          },
        })
      );
      const handler = getRegisteredIpcMainHandler('logging:select-destination');
      await expect(handler()).resolves.toEqual({ error: refusal.failure, ok: false });
    });

    it('select-destination handler delegates to selectDestination', async () => {
      const handlers = createMockHandlers({
        selectDestination: vi.fn(async () => '/selected/path'),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:select-destination');
      const result = await handler();

      expect(handlers.selectDestination).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: '/selected/path' });
    });

    it('open-destination handler delegates to openDestination', async () => {
      const handlers = createMockHandlers({
        openDestination: vi.fn(async () => true),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:open-destination');
      const result = await handler({}, '/some/path');

      expect(handlers.openDestination).toHaveBeenCalledWith('/some/path');
      expect(result).toEqual({ ok: true, value: true });
    });

    it('get-buffered-logs handler delegates to getBufferedLogs', async () => {
      const records = [createValidLogRecord()];
      const handlers = createMockHandlers({
        getBufferedLogs: vi.fn(() => records),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:get-buffered-logs');
      const result = await handler();

      expect(handlers.getBufferedLogs).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: records });
    });

    it('ingest-buffered-record listener validates and forwards log records', () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const listener = getRegisteredIpcMainListener('logging:ingest-buffered-record');
      const validRecord = createValidLogRecord();
      const mockEvent = { sender: { id: 42 } } as unknown as IpcMainEvent;

      listener(mockEvent, validRecord);

      expect(handlers.ingestBufferedLog).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          args: ['test message'],
          level: LogLevel.INFO,
        })
      );
    });

    it('ingest-buffered-record listener rejects invalid payloads', () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const listener = getRegisteredIpcMainListener('logging:ingest-buffered-record');
      const mockEvent = { sender: { id: 1 } } as unknown as IpcMainEvent;

      // null payload
      expect(() => listener(mockEvent, null)).toThrow('Buffered log record must be an object.');

      // string payload
      expect(() => listener(mockEvent, 'not-an-object')).toThrow(
        'Buffered log record must be an object.'
      );

      // array payload
      expect(() => listener(mockEvent, [1, 2, 3])).toThrow(
        'Buffered log record must be an object.'
      );
    });

    it('cleanup function removes all handlers and listeners', () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      cleanup();

      const removeHandlerChannels = (mockIpcMain.removeHandler.mock.calls as [string][]).map(
        ([ch]) => ch
      );

      expect(removeHandlerChannels).toContain('logging:get-preferences');
      expect(removeHandlerChannels).toContain('logging:set-preferences');
      expect(removeHandlerChannels).toContain('logging:select-destination');
      expect(removeHandlerChannels).toContain('logging:open-destination');
      expect(removeHandlerChannels).toContain('logging:get-buffered-logs');

      expect(mockIpcMain.removeListener).toHaveBeenCalledWith(
        'logging:ingest-buffered-record',
        expect.any(Function)
      );
    });
  });

  // ── assertLogRecord (tested through the ingest listener) ────────────
  describe('assertLogRecord validation (via ingest-buffered-record)', () => {
    let cleanup: () => void;
    let listener: (...args: unknown[]) => unknown;
    const mockEvent = { sender: { id: 1 } } as unknown as IpcMainEvent;

    beforeEach(() => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);
      listener = getRegisteredIpcMainListener('logging:ingest-buffered-record');
    });

    afterEach(() => {
      cleanup?.();
    });

    it('rejects record with invalid level', () => {
      const record = { ...createValidLogRecord(), level: 'invalid' };
      expect(() => listener(mockEvent, record)).toThrow('Buffered log record has invalid level.');
    });

    it('accepts all valid log levels', () => {
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
      for (const level of levels) {
        const record = { ...createValidLogRecord(), level };
        expect(() => listener(mockEvent, record)).not.toThrow();
      }
    });

    it('rejects record with non-numeric timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: 'not-a-number' };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with NaN timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: Number.NaN };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with Infinity timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: Number.POSITIVE_INFINITY };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with missing args array', () => {
      const record = { ...createValidLogRecord(), args: 'not-an-array' };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include args array.'
      );
    });

    it('rejects record with null bindings', () => {
      const record = { ...createValidLogRecord(), bindings: null };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include bindings object.'
      );
    });

    it('rejects record with array bindings', () => {
      const record = { ...createValidLogRecord(), bindings: [1, 2] };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record must include bindings object.'
      );
    });

    it('rejects record with non-string message', () => {
      const record = { ...createValidLogRecord(), message: 42 };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record message must be a string when present.'
      );
    });

    it('accepts record with undefined message', () => {
      const record = createValidLogRecord();
      (record as unknown as Record<string, unknown>)['message'] = undefined;
      expect(() => listener(mockEvent, record)).not.toThrow();
    });

    it('rejects record with non-string scope', () => {
      const record = { ...createValidLogRecord(), scope: 123 };
      expect(() => listener(mockEvent, record)).toThrow(
        'Buffered log record scope must be a string when present.'
      );
    });

    it('accepts record with undefined scope', () => {
      const record = createValidLogRecord();
      (record as unknown as Record<string, unknown>)['scope'] = undefined;
      expect(() => listener(mockEvent, record)).not.toThrow();
    });
  });

  // ── broadcastLoggingPreferences (tested through set-preferences) ────
  describe('broadcastLoggingPreferences', () => {
    let cleanup: () => void;

    afterEach(() => {
      cleanup?.();
    });

    it('sends preferences to window-type webContents', async () => {
      const mockContent = {
        getType: vi.fn(() => 'window'),
        id: 1,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      await handler({}, createMockPreferences());

      expect(mockContent.send).toHaveBeenCalledWith(
        'logging:preferences-updated',
        expect.any(Object)
      );
    });

    it('sends preferences to webview-type webContents', async () => {
      const mockContent = {
        getType: vi.fn(() => 'webview'),
        id: 2,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      await handler({}, createMockPreferences());

      expect(mockContent.send).toHaveBeenCalledWith(
        'logging:preferences-updated',
        expect.any(Object)
      );
    });

    it('skips destroyed webContents', async () => {
      const mockContent = {
        getType: vi.fn(() => 'window'),
        id: 3,
        isDestroyed: vi.fn(() => true),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      await handler({}, createMockPreferences());

      expect(mockContent.send).not.toHaveBeenCalled();
    });

    it('skips webContents with unsupported type (e.g. backgroundPage)', async () => {
      const mockContent = {
        getType: vi.fn(() => 'backgroundPage'),
        id: 4,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      await handler({}, createMockPreferences());

      expect(mockContent.send).not.toHaveBeenCalled();
    });

    it('handles send() throwing gracefully (webContents disappears mid-broadcast)', async () => {
      const mockContent = {
        getType: vi.fn(() => 'window'),
        id: 5,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(() => {
          throw new Error('WebContents destroyed during send');
        }),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');

      // Should not throw even though send() throws
      await expect(handler({}, createMockPreferences())).resolves.toBeDefined();
    });

    it('handles webContents with missing getType method', async () => {
      const mockContent = {
        getType: undefined,
        id: 6,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      setMockWebContents([mockContent]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');

      // getType?.() returns undefined, so targetType is neither 'window' nor 'webview'.
      // The code should skip and log debug, not crash.
      await expect(handler({}, createMockPreferences())).resolves.toBeDefined();
      expect(mockContent.send).not.toHaveBeenCalled();
    });

    it('broadcasts to multiple webContents instances', async () => {
      const mockWindow = {
        getType: vi.fn(() => 'window'),
        id: 10,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      const mockWebview = {
        getType: vi.fn(() => 'webview'),
        id: 11,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      };
      const mockDestroyed = {
        getType: vi.fn(() => 'window'),
        id: 12,
        isDestroyed: vi.fn(() => true),
        send: vi.fn(),
      };

      setMockWebContents([mockWindow, mockWebview, mockDestroyed]);

      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = getRegisteredIpcMainHandler('logging:set-preferences');
      await handler({}, createMockPreferences());

      expect(mockWindow.send).toHaveBeenCalled();
      expect(mockWebview.send).toHaveBeenCalled();
      expect(mockDestroyed.send).not.toHaveBeenCalled();
    });
  });

  // ── cloneLoggingSettingsPayload ─────────────────────────────────────
  describe('cloneLoggingSettingsPayload', () => {
    it('returns a deep-enough clone of the payload', () => {
      const original = createMockPayload();
      const cloned = cloneLoggingSettingsPayload(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.preferences).not.toBe(original.preferences);
      expect(cloned.preferences.redactPaths).not.toBe(original.preferences.redactPaths);
      expect(cloned.preferences.file).not.toBe(original.preferences.file);
      expect(cloned.capabilities).not.toBe(original.capabilities);
    });

    it('does not propagate mutations from clone to original', () => {
      const original = createMockPayload({ redactPaths: ['/secret'] });
      const cloned = cloneLoggingSettingsPayload(original);

      (cloned.preferences.redactPaths as string[]).push('/another');
      cloned.preferences.file.enabled = true;
      cloned.capabilities.canSelectDestination = false;

      expect(original.preferences.redactPaths).toEqual(['/secret']);
      expect(original.preferences.file.enabled).toBe(false);
      expect(original.capabilities.canSelectDestination).toBe(true);
    });
  });

  // ── cloneLoggingPreferences ─────────────────────────────────────────
  describe('cloneLoggingPreferences', () => {
    it('returns a clone of preferences', () => {
      const original = createMockPreferences({
        redactPaths: ['/a', '/b'],
      });
      const cloned = cloneLoggingPreferences(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.redactPaths).not.toBe(original.redactPaths);
      expect(cloned.file).not.toBe(original.file);
    });

    it('does not propagate mutations from clone to original', () => {
      const original = createMockPreferences({
        consoleEnabled: true,
        redactPaths: ['/path1'],
      });
      const cloned = cloneLoggingPreferences(original);

      cloned.consoleEnabled = false;
      (cloned.redactPaths as string[]).push('/path2');
      cloned.file.destination = '/new/path';

      expect(original.consoleEnabled).toBe(true);
      expect(original.redactPaths).toEqual(['/path1']);
      expect(original.file.destination).toBeNull();
    });
  });
});
