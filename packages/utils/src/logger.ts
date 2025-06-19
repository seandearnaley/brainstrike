import { isDevEnv } from './env-utils';

/**
 * Logger configuration options
 */
export interface LoggerConfig {
  /** Whether to enable logging in production. Default: false */
  enableInProduction?: boolean;
  /** Prefix to add to all log messages */
  prefix?: string | undefined;
  /** Whether to include timestamps. Default: false */
  includeTimestamp?: boolean;
}

/**
 * Log levels for filtering
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

let globalConfig: LoggerConfig = {};
let currentLogLevel: LogLevel = LogLevel.DEBUG;

/**
 * Reset logger configuration to defaults (for testing)
 */
export function resetLogger(): void {
  globalConfig = {};
  currentLogLevel = LogLevel.DEBUG;
}

/**
 * Configure the global logger settings
 */
export function configureLogger(config: LoggerConfig): void {
  globalConfig = { ...globalConfig, ...config };
}

/**
 * Set the minimum log level. Messages below this level will not be logged.
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Format a log message with optional prefix and timestamp
 */
function formatMessage(level: string, args: unknown[]): unknown[] {
  const parts: unknown[] = [];

  if (globalConfig.includeTimestamp) {
    parts.push(`[${new Date().toISOString()}]`);
  }

  if (globalConfig.prefix) {
    parts.push(`[${globalConfig.prefix}]`);
  }

  parts.push(`[${level}]`);

  return [...parts, ...args];
}

/**
 * Check if logging should occur based on environment and config
 */
function shouldLog(): boolean {
  if (globalConfig.enableInProduction) {
    return true;
  }
  return isDevEnv();
}

/**
 * Log debug messages (only in development by default)
 */
export function debug(...args: unknown[]): void {
  if (shouldLog() && currentLogLevel <= LogLevel.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(...formatMessage('DEBUG', args));
  }
}

/**
 * Log info messages (only in development by default)
 */
export function info(...args: unknown[]): void {
  if (shouldLog() && currentLogLevel <= LogLevel.INFO) {
    // eslint-disable-next-line no-console
    console.info(...formatMessage('INFO', args));
  }
}

/**
 * Log warning messages (only in development by default)
 */
export function warn(...args: unknown[]): void {
  if (shouldLog() && currentLogLevel <= LogLevel.WARN) {
    // eslint-disable-next-line no-console
    console.warn(...formatMessage('WARN', args));
  }
}

/**
 * Log error messages (only in development by default)
 */
export function error(...args: unknown[]): void {
  if (shouldLog() && currentLogLevel <= LogLevel.ERROR) {
    // eslint-disable-next-line no-console
    console.error(...formatMessage('ERROR', args));
  }
}

/**
 * Create a logger instance with a specific prefix
 */
export function createLogger(prefix: string): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  return {
    debug: (...args: unknown[]) => {
      const previousPrefix = globalConfig.prefix;
      globalConfig.prefix = prefix;
      debug(...args);
      globalConfig.prefix = previousPrefix;
    },
    info: (...args: unknown[]) => {
      const previousPrefix = globalConfig.prefix;
      globalConfig.prefix = prefix;
      info(...args);
      globalConfig.prefix = previousPrefix;
    },
    warn: (...args: unknown[]) => {
      const previousPrefix = globalConfig.prefix;
      globalConfig.prefix = prefix;
      warn(...args);
      globalConfig.prefix = previousPrefix;
    },
    error: (...args: unknown[]) => {
      const previousPrefix = globalConfig.prefix;
      globalConfig.prefix = prefix;
      error(...args);
      globalConfig.prefix = previousPrefix;
    },
  };
}

/**
 * Legacy aliases for backward compatibility
 */
export const log = debug;
export const logInfo = info;
export const logError = error;
export const logWarn = warn;
