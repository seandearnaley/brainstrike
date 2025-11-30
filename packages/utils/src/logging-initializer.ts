import type { CustomTransportConfig } from './logger';
import {
  type ConsoleTransportConfig,
  configureLogger,
  type FileTransportConfig,
  type LoggerConfig,
  type LogLevel,
} from './logger';

export type LoggerRuntime = 'browser' | 'electron-main' | 'electron-renderer';

export type FileLoggingOptions = {
  destination: string;
  level?: LogLevel;
  mkdir?: boolean;
  append?: boolean;
};

export type InitializeLoggingOptions = {
  runtime: LoggerRuntime;
  level?: LogLevel;
  consoleLevel?: LogLevel;
  includeTimestamp?: boolean;
  scopeKey?: string;
  appName?: string;
  appVersion?: string;
  baseBindings?: Record<string, unknown>;
  enableDebugInProduction?: boolean;
  file?: FileLoggingOptions;
  customTransports?: readonly CustomTransportConfig[];
};

function resolveBaseBindings(options: InitializeLoggingOptions): Record<string, unknown> {
  const { runtime, appName, appVersion, baseBindings } = options;
  return {
    runtime,
    ...(appName ? { application: appName } : {}),
    ...(appVersion ? { version: appVersion } : {}),
    ...(baseBindings ?? {}),
  };
}

function resolveConsoleConfig(
  level: LogLevel | undefined,
  consoleLevel: LogLevel | undefined
): ConsoleTransportConfig {
  const config: ConsoleTransportConfig = { enabled: true };
  const effectiveLevel = consoleLevel ?? level;
  if (effectiveLevel !== undefined) {
    config.level = effectiveLevel;
  }
  return config;
}

function resolveFileConfig(
  runtime: LoggerRuntime,
  file: FileLoggingOptions | undefined
): FileTransportConfig | false | undefined {
  if (runtime === 'electron-main' && file) {
    const config: FileTransportConfig = {
      destination: file.destination,
    };

    if (file.level !== undefined) {
      config.level = file.level;
    }

    if (file.mkdir !== undefined) {
      config.mkdir = file.mkdir;
    }

    if (file.append !== undefined) {
      config.append = file.append;
    }

    return config;
  }

  if (runtime !== 'electron-main') {
    return false;
  }

  return;
}

function resolveEnableInProduction(
  runtime: LoggerRuntime,
  enableDebugInProduction: boolean | undefined
): boolean {
  return enableDebugInProduction ?? runtime !== 'browser';
}

export function initializeLogging(options: InitializeLoggingOptions): void {
  const loggerConfig: LoggerConfig = {
    enableInProduction: resolveEnableInProduction(options.runtime, options.enableDebugInProduction),
    baseBindings: resolveBaseBindings(options),
    console: resolveConsoleConfig(options.level, options.consoleLevel),
  };

  if (options.level !== undefined) {
    loggerConfig.level = options.level;
  }

  if (options.includeTimestamp !== undefined) {
    loggerConfig.includeTimestamp = options.includeTimestamp;
  }

  if (options.scopeKey !== undefined) {
    loggerConfig.scopeKey = options.scopeKey;
  }

  if (options.customTransports) {
    loggerConfig.customTransports = options.customTransports;
  }

  const fileConfig = resolveFileConfig(options.runtime, options.file);
  if (fileConfig !== undefined) {
    loggerConfig.file = fileConfig;
  }

  configureLogger(loggerConfig);
}
