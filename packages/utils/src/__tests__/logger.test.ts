import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as envUtils from '../env-utils';
import {
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

    it('enables debug logging in production when configured', () => {
      setEnvironment(false);
      configureLogger({ enableInProduction: true });

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

      expect(record?.bindings.prefix).toBe('Brainstrike');
      expect(record?.bindings.environment).toBe('test');
    });

    it('uses custom scope keys for scoped loggers', () => {
      configureLogger({ scopeKey: 'component' });
      const scopedLogger = createLogger('Importer');

      const [record] = collectLogs(() => {
        scopedLogger.debug('component ready');
      });

      expect(record?.bindings.component).toBe('Importer');
      expect(record?.level).toBe(LogLevel.DEBUG);
    });

    it('captures scoped metadata with default key', () => {
      const scopedLogger = createLogger('DbProvider');

      const [record] = collectLogs(() => {
        scopedLogger.warn('initialising');
      });

      expect(record?.bindings.scope).toBe('DbProvider');
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
  });

  describe('legacy aliases', () => {
    beforeEach(() => {
      setEnvironment(true);
    });

    it('continues to emit records for legacy helpers', () => {
      const records = collectLogs(() => {
        log('debug via log');
        logInfo('info via logInfo');
        logWarn('warn via logWarn');
        logError('error via logError');
      });

      expect(records.map((record) => record.level)).toEqual([
        LogLevel.DEBUG,
        LogLevel.INFO,
        LogLevel.WARN,
        LogLevel.ERROR,
      ]);
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
      expect(records[0]?.bindings.scope).toBe('TestScope');
      expect(records[1]?.bindings.scope).toBe('TestScope');
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
        debug('should appear with default level');
      });

      expect(records).toHaveLength(1);
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
});
