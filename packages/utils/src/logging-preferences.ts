import {
  type ConsoleTransportConfig,
  configureLogger,
  type LoggerConfig,
  LogLevel,
} from '@brainstrike/utils/logger';
import type { LoggerRuntime } from './logging-initializer';

export interface FileLoggingPreferences {
  append: boolean;
  destination: string | null;
  enabled: boolean;
  level: LogLevel;
  mkdir: boolean;
}

export interface LoggingPreferences {
  consoleEnabled: boolean;
  consoleLevel: LogLevel;
  file: FileLoggingPreferences;
  includeTimestamp: boolean;
  level: LogLevel;
  redactPaths: readonly string[];
}

export function createDefaultLoggingPreferences(
  overrides?: Partial<LoggingPreferences>
): LoggingPreferences {
  const defaults: LoggingPreferences = {
    consoleEnabled: true,
    consoleLevel: LogLevel.INFO,
    file: {
      append: true,
      destination: null,
      enabled: false,
      level: LogLevel.INFO,
      mkdir: true,
    },
    includeTimestamp: false,
    level: LogLevel.INFO,
    redactPaths: [],
  };

  if (!overrides) {
    return defaults;
  }

  const merged: LoggingPreferences = {
    ...defaults,
    ...overrides,
    file: {
      ...defaults.file,
      ...(overrides.file ?? {}),
    },
    redactPaths: overrides.redactPaths ?? defaults.redactPaths,
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
    append: preferences.file.append,
    destination,
    enabled: true,
    level: preferences.file.level,
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
    console: buildConsoleConfig(preferences),
    includeTimestamp: preferences.includeTimestamp,
    level: preferences.level,
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
