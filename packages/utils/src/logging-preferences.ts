import {
  type ConsoleTransportConfig,
  configureLogger,
  type LoggerConfig,
  LogLevel,
} from './logger';
import type { LoggerRuntime } from './logging-initializer';

export interface FileLoggingPreferences {
  enabled: boolean;
  destination: string | null;
  level: LogLevel;
  append: boolean;
  mkdir: boolean;
}

export interface LoggingPreferences {
  level: LogLevel;
  consoleLevel: LogLevel;
  includeTimestamp: boolean;
  consoleEnabled: boolean;
  redactPaths: readonly string[];
  file: FileLoggingPreferences;
}

export function createDefaultLoggingPreferences(
  overrides?: Partial<LoggingPreferences>
): LoggingPreferences {
  const defaults: LoggingPreferences = {
    level: LogLevel.INFO,
    consoleLevel: LogLevel.INFO,
    includeTimestamp: false,
    consoleEnabled: true,
    redactPaths: [],
    file: {
      enabled: false,
      destination: null,
      level: LogLevel.INFO,
      append: true,
      mkdir: true,
    },
  };

  if (!overrides) {
    return defaults;
  }

  const merged: LoggingPreferences = {
    ...defaults,
    ...overrides,
    redactPaths: overrides.redactPaths ?? defaults.redactPaths,
    file: {
      ...defaults.file,
      ...(overrides.file ?? {}),
    },
  };

  return merged;
}

function buildConsoleConfig(preferences: LoggingPreferences): ConsoleTransportConfig | false {
  if (!preferences.consoleEnabled) {
    return false;
  }

  const config: ConsoleTransportConfig = {
    enabled: true,
    level: preferences.consoleLevel,
  };

  return config;
}

function buildFileConfig(
  preferences: LoggingPreferences,
  runtime: LoggerRuntime
): LoggerConfig['file'] {
  if (runtime !== 'electron-main') {
    return false;
  }

  if (!preferences.file.enabled) {
    return false;
  }

  const destination = preferences.file.destination?.trim();
  if (!destination) {
    return false;
  }

  return {
    enabled: true,
    destination,
    level: preferences.file.level,
    append: preferences.file.append,
    mkdir: preferences.file.mkdir,
  };
}

function normalizeRedactPaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)));
}

export function applyLoggingPreferences(
  preferences: LoggingPreferences,
  runtime: LoggerRuntime,
  additionalConfig?: Pick<LoggerConfig, 'baseBindings'>
): void {
  const config: LoggerConfig = {
    level: preferences.level,
    includeTimestamp: preferences.includeTimestamp,
    console: buildConsoleConfig(preferences),
    redactPaths: normalizeRedactPaths(preferences.redactPaths),
  };

  const fileConfig = buildFileConfig(preferences, runtime);
  if (fileConfig !== undefined) {
    config.file = fileConfig;
  }

  if (additionalConfig?.baseBindings) {
    config.baseBindings = additionalConfig.baseBindings;
  }

  configureLogger(config);
}
