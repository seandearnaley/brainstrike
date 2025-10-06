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
function formatMessage(level: string, args: unknown[], scopePrefix?: string): unknown[] {
  const parts: unknown[] = [];

  if (globalConfig.includeTimestamp) {
    parts.push(`[${new Date().toISOString()}]`);
  }

  if (scopePrefix) {
    parts.push(`[${scopePrefix}]`);
  } else if (globalConfig.prefix) {
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
  debugWithScope(undefined, ...args);
}

/**
 * Log debug messages with a specific scope prefix
 */
function debugWithScope(scopePrefix: string | undefined, ...args: unknown[]): void {
  if (shouldLog() && currentLogLevel <= LogLevel.DEBUG) {
    console.log(...formatMessage('DEBUG', args, scopePrefix));
  }
}

/**
 * Log info messages (ALWAYS logged for import operations)
 */
export function info(...args: unknown[]): void {
  infoWithScope(undefined, ...args);
}

/**
 * Log info messages with a specific scope prefix (ALWAYS logged)
 */
function infoWithScope(scopePrefix: string | undefined, ...args: unknown[]): void {
  // ALWAYS log info, critical for tracking import progress
  if (currentLogLevel <= LogLevel.INFO) {
    console.info(...formatMessage('INFO', args, scopePrefix));
  }
}

/**
 * Log warning messages (ALWAYS logged)
 */
export function warn(...args: unknown[]): void {
  warnWithScope(undefined, ...args);
}

/**
 * Log warning messages with a specific scope prefix (ALWAYS logged)
 */
function warnWithScope(scopePrefix: string | undefined, ...args: unknown[]): void {
  // ALWAYS log warnings
  if (currentLogLevel <= LogLevel.WARN) {
    console.warn(...formatMessage('WARN', args, scopePrefix));
  }
}

/**
 * Log error messages (ALWAYS logged, even in production)
 */
export function error(...args: unknown[]): void {
  errorWithScope(undefined, ...args);
}

/**
 * Log error messages with a specific scope prefix (ALWAYS logged)
 */
function errorWithScope(scopePrefix: string | undefined, ...args: unknown[]): void {
  // ALWAYS log errors, even in production - critical for debugging
  if (currentLogLevel <= LogLevel.ERROR) {
    console.error(...formatMessage('ERROR', args, scopePrefix));
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
    debug: (...args: unknown[]) => debugWithScope(prefix, ...args),
    info: (...args: unknown[]) => infoWithScope(prefix, ...args),
    warn: (...args: unknown[]) => warnWithScope(prefix, ...args),
    error: (...args: unknown[]) => errorWithScope(prefix, ...args),
  };
}

/**
 * Legacy aliases for backward compatibility
 */
export const log = debug;
export const logInfo = info;
export const logError = error;
export const logWarn = warn;
