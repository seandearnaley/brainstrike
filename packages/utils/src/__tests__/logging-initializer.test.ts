import {
  type ConsoleTransportConfig,
  type LoggerConfig,
  LogLevel,
} from '@brainstrike/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeLogging } from '../logging-initializer';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    configureLogger: vi.fn(),
  };
});

const { configureLogger } = await import('@brainstrike/utils/logger');

describe('initializeLogging', () => {
  afterEach(() => {
    vi.mocked(configureLogger).mockClear();
  });

  it('configures browser runtime without file transport', () => {
    initializeLogging({
      runtime: 'browser',
      level: LogLevel.INFO,
      consoleLevel: LogLevel.DEBUG,
      appName: 'brainstrike-web',
      appVersion: '1.2.3',
      baseBindings: { mode: 'test' },
    });

    expect(configureLogger).toHaveBeenCalledTimes(1);
    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config).toMatchObject({
      level: LogLevel.INFO,
      enableInProduction: false,
      baseBindings: {
        runtime: 'browser',
        application: 'brainstrike-web',
        version: '1.2.3',
        mode: 'test',
      },
      console: {
        enabled: true,
        level: LogLevel.DEBUG,
      } satisfies ConsoleTransportConfig,
      file: false,
    });
  });

  it('enables file logging when running in electron main', () => {
    initializeLogging({
      runtime: 'electron-main',
      level: LogLevel.DEBUG,
      includeTimestamp: true,
      scopeKey: 'service',
      enableDebugInProduction: true,
      consoleLevel: LogLevel.INFO,
      appName: 'brainstrike-desktop',
      file: {
        destination: '/tmp/brainstrike.log',
        level: LogLevel.ERROR,
        mkdir: false,
        append: false,
      },
      customTransports: [
        {
          target: 'datadog-transport',
          level: LogLevel.WARN,
          options: { service: 'brainstrike' },
        },
      ],
    });

    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config).toMatchObject({
      level: LogLevel.DEBUG,
      includeTimestamp: true,
      scopeKey: 'service',
      enableInProduction: true,
      baseBindings: {
        runtime: 'electron-main',
        application: 'brainstrike-desktop',
      },
      console: {
        enabled: true,
        level: LogLevel.INFO,
      },
      file: {
        destination: '/tmp/brainstrike.log',
        level: LogLevel.ERROR,
        mkdir: false,
        append: false,
      },
      customTransports: [
        {
          target: 'datadog-transport',
          level: LogLevel.WARN,
          options: { service: 'brainstrike' },
        },
      ],
    });
  });

  it('suppresses file transport in renderer contexts even when provided', () => {
    initializeLogging({
      runtime: 'electron-renderer',
      consoleLevel: LogLevel.INFO,
      appVersion: '0.0.0-dev',
      file: {
        destination: '/should/not/be/used.log',
      },
    });

    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config.file).toBe(false);
    expect(config.baseBindings).toMatchObject({
      runtime: 'electron-renderer',
      version: '0.0.0-dev',
    });
  });
});
