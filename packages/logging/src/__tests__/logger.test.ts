import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  redactSensitiveLogValue,
  resetLogger,
  setLogLevel,
  warn,
} from '../logger.js';

describe('redactSensitiveLogValue cause chains', () => {
  it('carries a nested Error cause through redaction', () => {
    const redacted = redactSensitiveLogValue(
      new Error('outer', { cause: new Error('root cause') })
    ) as Record<string, unknown>;
    expect((redacted['cause'] as Record<string, unknown>)['message']).toBe('root cause');
  });

  it('terminates on a self-referential cause cycle', () => {
    const cyclic = new Error('self');
    (cyclic as Error & { cause: unknown }).cause = cyclic;
    const redacted = redactSensitiveLogValue(cyclic) as Record<string, unknown>;
    // The memoized redacted object breaks the cycle: cause resolves to itself.
    expect(redacted['cause']).toBe(redacted);
    expect(redacted['message']).toBe('self');
  });

  it('terminates on a mutual cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause: unknown }).cause = b;
    const redacted = redactSensitiveLogValue(a) as Record<string, unknown>;
    const causeB = redacted['cause'] as Record<string, unknown>;
    expect(causeB['message']).toBe('b');
    expect(causeB['cause']).toBe(redacted);
  });
});

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

describe('logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default and explicit levels', () => {
    it('suppresses debug logs at the default INFO level', () => {
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

    it('enables debug logging when configured with an explicit level', () => {
      configureLogger({ level: LogLevel.DEBUG });

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
      resetLogger();
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
    it('adds global bindings when configured', () => {
      configureLogger({
        baseBindings: { environment: 'test' },
        prefix: 'Brainstrike',
      });

      const [record] = collectLogs(() => {
        info('hello world');
      });

      expect(record?.bindings['prefix']).toBe('Brainstrike');
      expect(record?.bindings['environment']).toBe('test');
    });

    it('uses custom scope keys for scoped loggers', () => {
      configureLogger({ level: LogLevel.DEBUG, scopeKey: 'component' });
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

    it('normalizes message-first structured calls for Pino transports', () => {
      const metadata = { error: new Error('boom'), toolIds: ['brainstrike.stale'] };

      expect(__loggerTesting.normalizePinoLogArgs(['Failed to initialize', metadata])).toEqual([
        metadata,
        'Failed to initialize',
      ]);

      const transport = vi.fn();
      __loggerTesting.writePinoLog(
        transport,
        {} as Parameters<typeof __loggerTesting.writePinoLog>[1],
        __loggerTesting.normalizePinoLogArgs(['Failed to initialize', metadata])
      );
      expect(transport).toHaveBeenCalledWith(metadata, 'Failed to initialize');
    });

    it('folds the error of a (message, metadata, error) call into the metadata', () => {
      const error = new Error('boom');

      expect(
        __loggerTesting.normalizePinoLogArgs(['Tab panel crashed', { label: 'Changes' }, error])
      ).toEqual([{ error, label: 'Changes' }, 'Tab panel crashed']);
      // A placeholder keeps Pino's interpolation, and longer calls stay variadic.
      expect(
        __loggerTesting.normalizePinoLogArgs(['loaded %o', { label: 'Changes' }, error])
      ).toEqual(['loaded %o', { label: 'Changes' }, error]);
      expect(
        __loggerTesting.normalizePinoLogArgs(['crashed', { label: 'Changes' }, error, 'extra'])
      ).toEqual(['crashed', { label: 'Changes' }, error, 'extra']);
    });

    it('redacts nested secrets before notifying log listeners', () => {
      class ProviderConfig {
        apiKey = 'class-secret';
      }

      configureLogger({
        baseBindings: {
          clientSecret: 'binding-secret',
          profile: { tenantId: 'binding-tenant-secret' },
        },
        redactPaths: [
          'profile.tenantId',
          'provider.accounts[*]["refresh.key"]',
          'provider.profile.tenantId',
          'provider.regions.*.credential',
          'sessionId',
        ],
      });

      const [record] = collectLogs(() => {
        info(
          {
            headers: { 'x-api-key': 'header-secret' },
            provider: {
              accessToken: 'access-secret',
              accounts: [{ 'refresh.key': 'refresh-secret' }],
              apiKey: 'sk-secret',
              authorization: 'Bearer secret',
              config: new ProviderConfig(),
              failure: Object.assign(new Error('provider failed'), { accessToken: 'error-secret' }),
              profile: { tenantId: 'tenant-secret' },
              regions: {
                east: { credential: 'east-secret' },
                west: { credential: 'west-secret' },
              },
              tokenCount: 42,
            },
            sessionId: 'session-secret',
          },
          'configured provider'
        );
      });

      expect(record?.bindings).toEqual({
        clientSecret: '[REDACTED]',
        profile: { tenantId: '[REDACTED]' },
      });
      expect(record?.args).toEqual([
        {
          headers: { 'x-api-key': '[REDACTED]' },
          provider: {
            accessToken: '[REDACTED]',
            accounts: [{ 'refresh.key': '[REDACTED]' }],
            apiKey: '[REDACTED]',
            authorization: '[REDACTED]',
            config: { apiKey: '[REDACTED]' },
            failure: {
              accessToken: '[REDACTED]',
              message: 'provider failed',
              name: 'Error',
              stack: expect.any(String),
            },
            profile: { tenantId: '[REDACTED]' },
            regions: {
              east: { credential: '[REDACTED]' },
              west: { credential: '[REDACTED]' },
            },
            tokenCount: 42,
          },
          sessionId: '[REDACTED]',
        },
        'configured provider',
      ]);
    });
  });

  describe('transport lifecycle', () => {
    afterEach(() => {
      resetLogger();
    });

    it('disables node transport output without disabling log listeners', () => {
      configureLogger({ console: false });

      expect(__loggerTesting.isRootTransportEnabled()).toBe(false);

      const records = collectLogs(() => {
        info('listener-only record');
      });

      expect(records.map((record) => record.message)).toEqual(['listener-only record']);
    });

    it('synchronously drains an old transport before ending it', () => {
      const lifecycle: string[] = [];

      __loggerTesting.drainNodeDestination({
        end: () => lifecycle.push('end'),
        flushSync: () => lifecycle.push('flush'),
        write: vi.fn(),
      });

      expect(lifecycle).toEqual(['flush', 'end']);
    });
  });

  describe('listeners', () => {
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
      setLogLevel(LogLevel.TRACE);
    });

    it('supports trace level logging', async () => {
      const { trace } = await import('../logger.js');
      const records = collectLogs(() => {
        trace('trace message');
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe(LogLevel.TRACE);
      expect(records[0]?.message).toBe('trace message');
    });

    it('supports fatal level logging', async () => {
      const { fatal } = await import('../logger.js');
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

    it('omits function-valued fields from browser console metadata', () => {
      expect(
        __loggerTesting.formatBrowserConsoleMessage(
          {
            attempt: 1,
            msg: 'read failed',
            nested: { callback: () => 'x', kept: true },
            restore: () => ({}),
            scope: 'ThemeProvider',
          },
          'scope',
          {}
        )
      ).toBe('[ThemeProvider] read failed {"attempt":1,"nested":{"kept":true}}');
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
          application: 'brainstrike-desktop',
          runtime: 'electron-renderer',
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
        expect.stringContaining('[DbProvider] Failed to initialize database {"error":{')
      );
      expect(formattedMessage).toEqual(expect.stringContaining('"message":"boom"'));
      expect(formattedMessage).toEqual(expect.stringContaining('"name":"Error"'));
    });

    it('respects browser console thresholds without affecting retained log records', () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const browserWrite = __loggerTesting.createBrowserWrite({
        baseBindings: { runtime: 'electron-renderer' },
        console: {
          enabled: true,
          level: LogLevel.WARN,
          options: {},
        },
        customTransports: [],
        includeTimestamp: false,
        scopeKey: 'scope',
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
        baseBindings: { runtime: 'electron-renderer' },
        console: {
          enabled: false,
          options: {},
        },
        customTransports: [],
        includeTimestamp: false,
        scopeKey: 'scope',
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
