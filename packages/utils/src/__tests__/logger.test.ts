import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as envUtils from '../env-utils';
import {
  __loggerTesting,
  addLogListener,
  configureLogger,
  createLogger,
  debug,
  error,
  info,
  LogLevel,
  type LogRecord,
  log,
  logError,
  logInfo,
  logWarn,
  resetLogger,
  setLogLevel,
  warn,
} from '../logger';

interface BrowserWriteMethods {
  error?: (value: unknown) => void;
  info?: (value: unknown) => void;
  warn?: (value: unknown) => void;
}

function collectLogs(callback: () => void): LogRecord[] {
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => {
    records.push(record);
  });

  try {
    callback();
  } finally {
    unsubscribe();
  }

  return records;
}

function setEnvironment(isDev: boolean): void {
  vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(isDev);
  resetLogger();
}

describe('logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('environment sensitive levels', () => {
    it('suppresses debug logs in production by default', () => {
      setEnvironment(false);

      const records = collectLogs(() => {
        debug('debug message');
        info('info message');
        warn('warn message');
        error('error message');
      });

      expect(records.map((record) => record.level)).toEqual([
        LogLevel.INFO,
        LogLevel.WARN,
        LogLevel.ERROR,
      ]);
    });

    it('enables debug logging in production when configured with explicit level', () => {
      setEnvironment(false);
      configureLogger({ enableInProduction: true, level: LogLevel.DEBUG });

      const records = collectLogs(() => {
        debug('debug message');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.DEBUG);
      expect(records[0]?.message).toBe('debug message');
    });
  });

  describe('log level overrides', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('filters logs below the configured level', () => {
      setLogLevel(LogLevel.WARN);

      const records = collectLogs(() => {
        debug('debug message');
        info('info message');
        warn('warn message');
        error('error message');
      });

      expect(records.map((record) => record.level)).toEqual([LogLevel.WARN, LogLevel.ERROR]);
    });

    it('silences all logs when level is silent', () => {
      setLogLevel(LogLevel.SILENT);

      const records = collectLogs(() => {
        debug('debug message');
        error('error message');
      });

      expect(records).toHaveLength(0);
    });
  });

  describe('structured metadata', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('adds global bindings when configured', () => {
      configureLogger({
        prefix: 'Brainstrike',
        baseBindings: { environment: 'test' },
      });

      const [record] = collectLogs(() => {
        info('hello world');
      });

      expect(record?.bindings['prefix']).toBe('Brainstrike');
      expect(record?.bindings['environment']).toBe('test');
    });

    it('uses custom scope keys for scoped loggers', () => {
      configureLogger({ scopeKey: 'component', level: LogLevel.DEBUG });
      const scopedLogger = createLogger('Importer');

      const [record] = collectLogs(() => {
        scopedLogger.debug('component ready');
      });

      expect(record?.bindings['component']).toBe('Importer');
      expect(record?.level).toBe(LogLevel.DEBUG);
    });

    it('captures scoped metadata with default key', () => {
      const scopedLogger = createLogger('DbProvider');

      const [record] = collectLogs(() => {
        scopedLogger.warn('initialising');
      });

      expect(record?.bindings['scope']).toBe('DbProvider');
      expect(record?.message).toBe('initialising');
    });
  });

  describe('listeners', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('allows listeners to unsubscribe cleanly', () => {
      const captured: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => {
        captured.push(record);
      });

      unsubscribe();
      debug('ignored');

      expect(captured).toHaveLength(0);
    });

    it('captures all arguments passed to log methods', () => {
      const [record] = collectLogs(() => {
        warn('warn message', { foo: 'bar' }, 42);
      });

      expect(record?.args).toEqual(['warn message', { foo: 'bar' }, 42]);
    });

    it('extracts the message from object-first structured log calls', () => {
      const [record] = collectLogs(() => {
        info({ cpuPercent: 34, rssKb: 790_480 }, 'main-process-health');
      });

      expect(record?.message).toBe('main-process-health');
      expect(record?.args).toEqual([{ cpuPercent: 34, rssKb: 790_480 }, 'main-process-health']);
    });

    it('handles empty and metadata-only log calls', () => {
      const records = collectLogs(() => {
        info();
        warn({ retryCount: 2 });
      });

      expect(records[0]?.args).toEqual([]);
      expect(records[0]?.message).toBeUndefined();
      expect(records[1]?.args).toEqual([{ retryCount: 2 }]);
      expect(records[1]?.message).toBeUndefined();
    });
  });

  describe('legacy aliases', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('continues to emit records for legacy helpers', () => {
      // Note: log() is an alias for debug(), which requires DEBUG level
      // With default INFO level, only info/warn/error are captured
      const records = collectLogs(() => {
        log('debug via log'); // Not captured at INFO level
        logInfo('info via logInfo');
        logWarn('warn via logWarn');
        logError('error via logError');
      });

      expect(records.map((record) => record.level)).toEqual([
        LogLevel.INFO,
        LogLevel.WARN,
        LogLevel.ERROR,
      ]);
    });

    it('emits debug logs via log() when level is DEBUG', () => {
      setLogLevel(LogLevel.DEBUG);

      const records = collectLogs(() => {
        log('debug via log');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.DEBUG);
    });
  });

  describe('trace and fatal levels', () => {
    beforeEach(() => {
      setEnvironment(true);
      setLogLevel(LogLevel.TRACE);
    });

    it('supports trace level logging', async () => {
      const { trace } = await import('../logger');
      const records = collectLogs(() => {
        trace('trace message');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.TRACE);
      expect(records[0]?.message).toBe('trace message');
    });

    it('supports fatal level logging', async () => {
      const { fatal } = await import('../logger');
      const records = collectLogs(() => {
        fatal('fatal message');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.FATAL);
      expect(records[0]?.message).toBe('fatal message');
    });

    it('includes trace and fatal in scoped loggers', () => {
      const scopedLogger = createLogger('TestScope');
      const records = collectLogs(() => {
        scopedLogger.trace('trace from scope');
        scopedLogger.fatal('fatal from scope');
      });

      expect(records).toHaveLength(2);
      expect(records[0]?.level).toBe(LogLevel.TRACE);
      expect(records[1]?.level).toBe(LogLevel.FATAL);
      expect(records[0]?.bindings['scope']).toBe('TestScope');
      expect(records[1]?.bindings['scope']).toBe('TestScope');
    });
  });

  describe('logger caching', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('returns the same logger instance for the same scope', () => {
      const logger1 = createLogger('CachedScope');
      const logger2 = createLogger('CachedScope');

      expect(logger1).toBe(logger2);
    });

    it('returns different logger instances for different scopes', () => {
      const logger1 = createLogger('ScopeA');
      const logger2 = createLogger('ScopeB');

      expect(logger1).not.toBe(logger2);
    });
  });

  describe('environment variable log level', () => {
    beforeEach(() => {
      setEnvironment(true);
      resetLogger();
    });

    afterEach(() => {
      process.env['LOG_LEVEL'] = undefined;
      resetLogger();
    });

    it('uses LOG_LEVEL env var when set', () => {
      process.env['LOG_LEVEL'] = 'error';
      resetLogger();

      const records = collectLogs(() => {
        debug('should be filtered');
        info('should be filtered');
        warn('should be filtered');
        error('should appear');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.ERROR);
    });

    it('handles case-insensitive LOG_LEVEL', () => {
      process.env['LOG_LEVEL'] = 'WaRn';
      resetLogger();

      const records = collectLogs(() => {
        debug('filtered');
        warn('appears');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.WARN);
    });

    it('ignores invalid LOG_LEVEL values', () => {
      process.env['LOG_LEVEL'] = 'invalid';
      resetLogger();

      const records = collectLogs(() => {
        info('should appear with default level');
        debug('should not appear - below default INFO level');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.INFO);
    });
  });

  describe('listener error handling', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('logs listener errors to console without breaking logging', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const throwingListener = vi.fn(() => {
        throw new Error('Listener failed');
      });
      const workingListener = vi.fn();

      const unsubscribe1 = addLogListener(throwingListener);
      const unsubscribe2 = addLogListener(workingListener);

      info('test message');

      expect(throwingListener).toHaveBeenCalled();
      expect(workingListener).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Logger] Listener error:', expect.any(Error));

      unsubscribe1();
      unsubscribe2();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('browser console formatting', () => {
    it('sanitizes browser console metadata recursively', () => {
      const circularObject: Record<string, unknown> = {
        name: 'root',
      };
      circularObject['self'] = circularObject;

      expect(
        __loggerTesting.sanitizeBrowserConsoleValue([
          new URL('https://brainstrike.test/search?q=coverage'),
          Symbol.for('logger-test'),
          circularObject,
        ])
      ).toEqual([
        'https://brainstrike.test/search?q=coverage',
        'Symbol(logger-test)',
        {
          name: 'root',
          self: '[Circular]',
        },
      ]);
    });

    it('formats primitive, metadata-only, and scope-only browser console values', () => {
      expect(__loggerTesting.formatBrowserConsoleMessage('plain text', 'scope', {})).toBe(
        'plain text'
      );

      expect(
        __loggerTesting.formatBrowserConsoleMessage(
          {
            level: 30,
            msg: 'message only',
            time: 123,
          },
          'scope',
          {}
        )
      ).toBe('message only');

      expect(
        __loggerTesting.formatBrowserConsoleMessage(
          {
            count: 2,
            level: 30,
            scope: 'Indexer',
            time: 123,
          },
          'scope',
          {}
        )
      ).toBe('[Indexer] {"count":2}');

      expect(
        __loggerTesting.formatBrowserConsoleMessage(
          {
            level: 30,
            scope: 'Indexer',
            time: 123,
          },
          'scope',
          {}
        )
      ).toBe('[Indexer]');
    });

    it('returns null metadata text when every sanitized field is undefined', () => {
      expect(
        __loggerTesting.formatBrowserConsoleMessage(
          {
            msg: '',
            optional: undefined,
            time: 123,
          },
          'scope',
          {}
        )
      ).toBe('[object Object]');
    });

    it('formats scoped structured logs as a single readable console line', () => {
      const formattedMessage = __loggerTesting.formatBrowserConsoleMessage(
        {
          application: 'brainstrike-desktop',
          level: 30,
          msg: 'Background renderer log forwarding enabled',
          runtime: 'electron-renderer',
          scope: 'DesktopRenderer',
          time: 123,
          version: '0.1.0',
          windowRole: 'embedding-host',
        },
        'scope',
        {
          runtime: 'electron-renderer',
          application: 'brainstrike-desktop',
          version: '0.1.0',
        }
      );

      expect(formattedMessage).toBe(
        '[DesktopRenderer] Background renderer log forwarding enabled {"windowRole":"embedding-host"}'
      );
    });

    it('serializes error metadata instead of relying on browser object formatting', () => {
      const formattedMessage = __loggerTesting.formatBrowserConsoleMessage(
        {
          error: new Error('boom'),
          level: 40,
          msg: 'Failed to initialize database',
          scope: 'DbProvider',
          time: 123,
        },
        'scope',
        {}
      );

      expect(formattedMessage).toEqual(
        expect.stringContaining(
          '[DbProvider] Failed to initialize database {"error":{"name":"Error","message":"boom"'
        )
      );
    });

    it('respects browser console thresholds without affecting retained log records', () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const browserWrite = __loggerTesting.createBrowserWrite({
        enableInProduction: true,
        includeTimestamp: false,
        scopeKey: 'scope',
        baseBindings: { runtime: 'electron-renderer' },
        console: {
          enabled: true,
          level: LogLevel.WARN,
          options: {},
        },
        customTransports: [],
      }) as BrowserWriteMethods;

      browserWrite.info?.({
        level: 30,
        msg: 'renderer info',
        runtime: 'electron-renderer',
        scope: 'DesktopRenderer',
        time: 1,
      });
      browserWrite.warn?.({
        level: 40,
        msg: 'renderer warn',
        runtime: 'electron-renderer',
        scope: 'DesktopRenderer',
        time: 2,
      });

      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith('[DesktopRenderer] renderer warn');
    });

    it('honors browser console disablement', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const browserWrite = __loggerTesting.createBrowserWrite({
        enableInProduction: true,
        includeTimestamp: false,
        scopeKey: 'scope',
        baseBindings: { runtime: 'electron-renderer' },
        console: {
          enabled: false,
          options: {},
        },
        customTransports: [],
      }) as BrowserWriteMethods;

      browserWrite.error?.({
        level: 50,
        msg: 'renderer error',
        runtime: 'electron-renderer',
        scope: 'DesktopRenderer',
        time: 3,
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
