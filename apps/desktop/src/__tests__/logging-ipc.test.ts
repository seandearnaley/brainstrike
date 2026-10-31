import { INTERNAL_FAULT, refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
import { createDefaultLoggingPreferences, LogLevel } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggingIpcHandlers } from '../logging-ipc';
import type { LoggingSettingsPayload } from '../logging-shared';
import { DESKTOP_IPC_PUSH_CHANNEL } from '../platform/desktop-ipc-channels';
import { assertBufferedLogRecord } from '../platform/logging-api-contract';
import { invokeDesktopIpc } from './helpers/desktop-ipc-sender-test-helpers';
import {
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
    defaults: createMockPreferences(),
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

    it('serves every logging method on the desktop IPC connection', async () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      for (const method of [
        'logging:get-preferences',
        'logging:select-destination',
        'logging:get-buffered-logs',
      ]) {
        await expect(invokeDesktopIpc(mockIpcMain, method)).resolves.toMatchObject({ ok: true });
      }
      await expect(
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', createMockPreferences())
      ).resolves.toMatchObject({ ok: true });
      await expect(
        invokeDesktopIpc(mockIpcMain, 'logging:open-destination', '/some/path')
      ).resolves.toMatchObject({ ok: true });
    });

    it('get-preferences handler delegates to getState', async () => {
      const payload = createMockPayload();
      const handlers = createMockHandlers({
        getState: vi.fn(() => payload),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:get-preferences', ...args);
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      const result = await handler(prefs);

      expect(handlers.setPreferences).toHaveBeenCalledWith(prefs);
      expect(result).toEqual({ ok: true, value: payload });
      expect(mockContent.send).toHaveBeenCalledWith(
        DESKTOP_IPC_PUSH_CHANNEL,
        expect.objectContaining({
          method: 'logging:preferences-updated',
          payload: expect.objectContaining({ consoleEnabled: false }),
        })
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);

      // Fire two updates concurrently
      const first = handler(createMockPreferences({ consoleEnabled: true }));
      const second = handler(createMockPreferences({ consoleEnabled: false }));

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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);

      // First call rejects
      await expect(handler(createMockPreferences())).resolves.toMatchObject({
        error: INTERNAL_FAULT,
        ok: false,
      });

      // Second call should still work (queue recovered)
      const result = await handler(createMockPreferences());
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
      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:select-destination', ...args);
      await expect(handler()).resolves.toEqual({ error: refusal.failure, ok: false });
    });

    it('select-destination handler delegates to selectDestination', async () => {
      const handlers = createMockHandlers({
        selectDestination: vi.fn(async () => '/selected/path'),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:select-destination', ...args);
      const result = await handler();

      expect(handlers.selectDestination).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: '/selected/path' });
    });

    it('open-destination handler delegates to openDestination', async () => {
      const handlers = createMockHandlers({
        openDestination: vi.fn(async () => true),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:open-destination', ...args);
      const result = await handler('/some/path');

      expect(handlers.openDestination).toHaveBeenCalledWith('/some/path');
      expect(result).toEqual({ ok: true, value: true });
    });

    it('get-buffered-logs handler delegates to getBufferedLogs', async () => {
      const records = [createValidLogRecord()];
      const handlers = createMockHandlers({
        getBufferedLogs: vi.fn(() => records),
      });
      cleanup = registerLoggingIpcHandlers(handlers);

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:get-buffered-logs', ...args);
      const result = await handler();

      expect(handlers.getBufferedLogs).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: records });
    });

    it('cleanup function removes every logging method', async () => {
      const handlers = createMockHandlers();
      cleanup = registerLoggingIpcHandlers(handlers);

      cleanup();

      for (const method of [
        'logging:get-preferences',
        'logging:set-preferences',
        'logging:select-destination',
        'logging:open-destination',
        'logging:get-buffered-logs',
      ]) {
        await expect(invokeDesktopIpc(mockIpcMain, method)).rejects.toThrow(
          `No desktop IPC handler for ${method}.`
        );
      }
    });
  });

  // ── assertBufferedLogRecord (the durable push's validation) ─────────
  describe('assertBufferedLogRecord validation', () => {
    it('rejects record with invalid level', () => {
      const record = { ...createValidLogRecord(), level: 'invalid' };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record has invalid level.'
      );
    });

    it('accepts all valid log levels', () => {
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
      for (const level of levels) {
        const record = { ...createValidLogRecord(), level };
        expect(() => assertBufferedLogRecord(record)).not.toThrow();
      }
    });

    it('rejects record with non-numeric timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: 'not-a-number' };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with NaN timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: Number.NaN };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with Infinity timestamp', () => {
      const record = { ...createValidLogRecord(), timestamp: Number.POSITIVE_INFINITY };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include a finite numeric timestamp.'
      );
    });

    it('rejects record with missing args array', () => {
      const record = { ...createValidLogRecord(), args: 'not-an-array' };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include args array.'
      );
    });

    it('rejects record with null bindings', () => {
      const record = { ...createValidLogRecord(), bindings: null };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include bindings object.'
      );
    });

    it('rejects record with array bindings', () => {
      const record = { ...createValidLogRecord(), bindings: [1, 2] };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record must include bindings object.'
      );
    });

    it('rejects record with non-string message', () => {
      const record = { ...createValidLogRecord(), message: 42 };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record message must be a string when present.'
      );
    });

    it('accepts record with undefined message', () => {
      const record = createValidLogRecord();
      (record as unknown as Record<string, unknown>)['message'] = undefined;
      expect(() => assertBufferedLogRecord(record)).not.toThrow();
    });

    it('rejects record with non-string scope', () => {
      const record = { ...createValidLogRecord(), scope: 123 };
      expect(() => assertBufferedLogRecord(record)).toThrow(
        'Buffered log record scope must be a string when present.'
      );
    });

    it('accepts record with undefined scope', () => {
      const record = createValidLogRecord();
      (record as unknown as Record<string, unknown>)['scope'] = undefined;
      expect(() => assertBufferedLogRecord(record)).not.toThrow();
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      await handler(createMockPreferences());

      expect(mockContent.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
        method: 'logging:preferences-updated',
        payload: expect.any(Object),
      });
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      await handler(createMockPreferences());

      expect(mockContent.send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
        method: 'logging:preferences-updated',
        payload: expect.any(Object),
      });
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      await handler(createMockPreferences());

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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      await handler(createMockPreferences());

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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);

      // Should not throw even though send() throws
      await expect(handler(createMockPreferences())).resolves.toBeDefined();
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);

      // getType?.() returns undefined, so targetType is neither 'window' nor 'webview'.
      // The code should skip and log debug, not crash.
      await expect(handler(createMockPreferences())).resolves.toBeDefined();
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

      const handler = (...args: unknown[]) =>
        invokeDesktopIpc(mockIpcMain, 'logging:set-preferences', ...args);
      await handler(createMockPreferences());

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
