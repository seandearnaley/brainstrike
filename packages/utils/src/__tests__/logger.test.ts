import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as envUtils from '../env-utils';
import {
  configureLogger,
  createLogger,
  debug,
  error,
  info,
  LogLevel,
  resetLogger,
  setLogLevel,
  warn,
} from '../logger';

// Create spies without mocking initially
const logSpy = vi.spyOn(console, 'log');
const infoSpy = vi.spyOn(console, 'info');
const warnSpy = vi.spyOn(console, 'warn');
const errorSpy = vi.spyOn(console, 'error');

describe('logger', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults
    resetLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Don't restore mocks here as it breaks the spies
  });

  describe('basic logging', () => {
    it('logs to console when in development', () => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
      debug('debug message');
      info('info message');
      warn('warn message');
      error('error message');

      expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'debug message');
      expect(infoSpy).toHaveBeenCalledWith('[INFO]', 'info message');
      expect(warnSpy).toHaveBeenCalledWith('[WARN]', 'warn message');
      expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'error message');
    });

    it('does not log when not in development', () => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(false);
      debug('debug');
      info('info');
      warn('warn');
      error('error');

      expect(logSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs in production when enableInProduction is true', () => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(false);
      configureLogger({ enableInProduction: true });

      debug('debug message');
      expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'debug message');
    });
  });

  describe('log levels', () => {
    beforeEach(() => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    });

    it('respects log level filtering', () => {
      setLogLevel(LogLevel.WARN);

      debug('debug');
      info('info');
      warn('warn');
      error('error');

      expect(logSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('silences all logs when level is NONE', () => {
      setLogLevel(LogLevel.NONE);

      debug('debug');
      info('info');
      warn('warn');
      error('error');

      expect(logSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('formatting', () => {
    beforeEach(() => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    });

    it('adds prefix when configured', () => {
      configureLogger({ prefix: 'MyApp' });

      debug('test message');
      expect(logSpy).toHaveBeenCalledWith('[MyApp]', '[DEBUG]', 'test message');
    });

    it('adds timestamp when configured', () => {
      const mockDate = new Date('2024-01-01T12:00:00.000Z');
      vi.spyOn(global, 'Date').mockImplementation(() => mockDate);

      configureLogger({ includeTimestamp: true });

      debug('test message');
      expect(logSpy).toHaveBeenCalledWith('[2024-01-01T12:00:00.000Z]', '[DEBUG]', 'test message');
    });

    it('combines prefix and timestamp', () => {
      const mockDate = new Date('2024-01-01T12:00:00.000Z');
      vi.spyOn(global, 'Date').mockImplementation(() => mockDate);

      configureLogger({ prefix: 'MyApp', includeTimestamp: true });

      debug('test message');
      expect(logSpy).toHaveBeenCalledWith(
        '[2024-01-01T12:00:00.000Z]',
        '[MyApp]',
        '[DEBUG]',
        'test message'
      );
    });
  });

  describe('createLogger', () => {
    beforeEach(() => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    });

    it('creates logger with specific prefix', () => {
      const logger = createLogger('ComponentA');

      logger.debug('test');
      expect(logSpy).toHaveBeenCalledWith('[ComponentA]', '[DEBUG]', 'test');
    });

    it('preserves global prefix after using created logger', () => {
      configureLogger({ prefix: 'GlobalApp' });
      const logger = createLogger('ComponentA');

      logger.debug('component message');
      debug('global message');

      expect(logSpy).toHaveBeenNthCalledWith(1, '[ComponentA]', '[DEBUG]', 'component message');
      expect(logSpy).toHaveBeenNthCalledWith(2, '[GlobalApp]', '[DEBUG]', 'global message');
    });

    it('handles undefined global prefix correctly', () => {
      const logger = createLogger('ComponentA');

      logger.debug('test');
      debug('global');

      expect(logSpy).toHaveBeenNthCalledWith(1, '[ComponentA]', '[DEBUG]', 'test');
      expect(logSpy).toHaveBeenNthCalledWith(2, '[DEBUG]', 'global');
    });
  });

  describe('legacy aliases', () => {
    beforeEach(() => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    });

    it('provides backward compatibility aliases', async () => {
      const { log, logInfo, logError, logWarn } = await import('../logger');

      log('debug via log');
      logInfo('info via logInfo');
      logWarn('warn via logWarn');
      logError('error via logError');

      expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'debug via log');
      expect(infoSpy).toHaveBeenCalledWith('[INFO]', 'info via logInfo');
      expect(warnSpy).toHaveBeenCalledWith('[WARN]', 'warn via logWarn');
      expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'error via logError');
    });
  });

  describe('multiple arguments', () => {
    beforeEach(() => {
      vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    });

    it('handles multiple arguments correctly', () => {
      debug('message', { foo: 'bar' }, 123, true);
      expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'message', { foo: 'bar' }, 123, true);
    });
  });
});
