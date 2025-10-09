import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loggerModule from '../logger';
import { LogLevel } from '../logger';
import { applyLoggingPreferences, createDefaultLoggingPreferences } from '../logging-preferences';

describe('logging-preferences', () => {
  const configureLoggerSpy = vi.spyOn(loggerModule, 'configureLogger');

  beforeEach(() => {
    configureLoggerSpy.mockClear();
  });

  afterEach(() => {
    configureLoggerSpy.mockReset();
  });

  afterAll(() => {
    configureLoggerSpy.mockRestore();
  });

  it('configures console logging when enabled', () => {
    const preferences = createDefaultLoggingPreferences({
      level: LogLevel.DEBUG,
      consoleLevel: LogLevel.INFO,
      includeTimestamp: true,
    });

    applyLoggingPreferences(preferences, 'browser');

    expect(configureLoggerSpy).toHaveBeenCalledTimes(1);
    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.DEBUG,
        includeTimestamp: true,
        console: expect.objectContaining({
          enabled: true,
          level: LogLevel.INFO,
        }),
        file: false,
      })
    );
  });

  it('disables console logging when consoleEnabled is false', () => {
    const preferences = createDefaultLoggingPreferences({
      consoleEnabled: false,
    });

    applyLoggingPreferences(preferences, 'browser');

    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        console: false,
      })
    );
  });

  it('configures file logging for electron-main runtime', () => {
    const preferences = createDefaultLoggingPreferences({
      file: {
        enabled: true,
        destination: '/tmp/brainstrike.log',
        level: LogLevel.DEBUG,
        mkdir: true,
        append: false,
      },
    });

    applyLoggingPreferences(preferences, 'electron-main');

    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        file: {
          enabled: true,
          destination: '/tmp/brainstrike.log',
          level: LogLevel.DEBUG,
          mkdir: true,
          append: false,
        },
      })
    );
  });

  it('deduplicates and trims redact paths', () => {
    const preferences = createDefaultLoggingPreferences({
      redactPaths: [' token ', 'password', 'token'],
    });

    applyLoggingPreferences(preferences, 'browser');

    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        redactPaths: ['token', 'password'],
      })
    );
  });
});
