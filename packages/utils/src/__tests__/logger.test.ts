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
});
