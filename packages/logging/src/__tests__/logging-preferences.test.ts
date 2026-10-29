import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loggerModule from '../logger.js';
import { LogLevel } from '../logger.js';
import {
  applyLoggingPreferences,
  createDefaultLoggingPreferences,
} from '../logging-preferences.js';

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

    expect(() => applyLoggingPreferences(preferences, 'electron-main')).toThrow(
      /explicit rotating fileTransport/u
    );
    expect(configureLoggerSpy).not.toHaveBeenCalled();
  });

  it('applies an Electron-owned rotating transport without changing file preferences', () => {
    const preferences = createDefaultLoggingPreferences({
      file: {
        append: true,
        destination: '/tmp/brainstrike.log',
        enabled: true,
        level: LogLevel.INFO,
        mkdir: true,
      },
    });

    applyLoggingPreferences(preferences, 'electron-main', {
      fileTransport: {
        options: {
          maxBytes: 10 * 1024 * 1024,
          maxFiles: 5,
        },
        target: '/app/dist/main-log-transport.js',
      },
    });

    expect(configureLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({
          append: true,
          destination: '/tmp/brainstrike.log',
          level: LogLevel.INFO,
          mkdir: true,
          options: {
            maxBytes: 10 * 1024 * 1024,
            maxFiles: 5,
          },
          target: '/app/dist/main-log-transport.js',
        }),
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
