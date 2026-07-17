import * as loggerModule from '@brainstrike/utils/logger';
import { LogLevel } from '@brainstrike/utils/logger';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      consoleLevel: LogLevel.INFO,
      includeTimestamp: true,
      level: LogLevel.DEBUG,
    });

    applyLoggingPreferences(preferences, 'browser');

    expect(configureLoggerSpy).toHaveBeenCalledTimes(1);
    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        console: expect.objectContaining({
          enabled: true,
          level: LogLevel.INFO,
        }),
        file: false,
        includeTimestamp: true,
        level: LogLevel.DEBUG,
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
        append: false,
        destination: '/tmp/brainstrike.log',
        enabled: true,
        level: LogLevel.DEBUG,
        mkdir: true,
      },
    });

    applyLoggingPreferences(preferences, 'electron-main');

    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        file: {
          append: false,
          destination: '/tmp/brainstrike.log',
          enabled: true,
          level: LogLevel.DEBUG,
          mkdir: true,
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
