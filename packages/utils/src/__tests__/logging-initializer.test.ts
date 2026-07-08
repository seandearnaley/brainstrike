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
      appName: 'brainstrike-web',
      appVersion: '1.2.3',
      baseBindings: { mode: 'test' },
      consoleLevel: LogLevel.DEBUG,
      level: LogLevel.INFO,
      runtime: 'browser',
    });

    expect(configureLogger).toHaveBeenCalledTimes(1);
    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config).toMatchObject({
      baseBindings: {
        application: 'brainstrike-web',
        mode: 'test',
        runtime: 'browser',
        version: '1.2.3',
      },
      console: {
        enabled: true,
        level: LogLevel.DEBUG,
      } satisfies ConsoleTransportConfig,
      enableInProduction: false,
      file: false,
      level: LogLevel.INFO,
    });
  });

  it('enables file logging when running in electron main', () => {
    initializeLogging({
      appName: 'brainstrike-desktop',
      consoleLevel: LogLevel.INFO,
      customTransports: [
        {
          level: LogLevel.WARN,
          options: { service: 'brainstrike' },
          target: 'datadog-transport',
        },
      ],
      enableDebugInProduction: true,
      file: {
        append: false,
        destination: '/tmp/brainstrike.log',
        level: LogLevel.ERROR,
        mkdir: false,
      },
      includeTimestamp: true,
      level: LogLevel.DEBUG,
      runtime: 'electron-main',
      scopeKey: 'service',
    });

    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config).toMatchObject({
      baseBindings: {
        application: 'brainstrike-desktop',
        runtime: 'electron-main',
      },
      console: {
        enabled: true,
        level: LogLevel.INFO,
      },
      customTransports: [
        {
          level: LogLevel.WARN,
          options: { service: 'brainstrike' },
          target: 'datadog-transport',
        },
      ],
      enableInProduction: true,
      file: {
        append: false,
        destination: '/tmp/brainstrike.log',
        level: LogLevel.ERROR,
        mkdir: false,
      },
      includeTimestamp: true,
      level: LogLevel.DEBUG,
      scopeKey: 'service',
    });
  });

  it('suppresses file transport in renderer contexts even when provided', () => {
    initializeLogging({
      appVersion: '0.0.0-dev',
      consoleLevel: LogLevel.INFO,
      file: {
        destination: '/should/not/be/used.log',
      },
      runtime: 'electron-renderer',
    });

    const [config] = vi.mocked(configureLogger).mock.calls[0] as [LoggerConfig];

    expect(config.file).toBe(false);
    expect(config.baseBindings).toMatchObject({
      runtime: 'electron-renderer',
      version: '0.0.0-dev',
    });
  });
});
