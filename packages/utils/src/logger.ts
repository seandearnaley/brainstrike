import pino, {
  type DestinationStream,
  type LoggerOptions,
  type Logger as PinoLogger,
  type TransportTargetOptions,
  transport,
} from 'pino';
import { isDevEnv } from './env-utils';

type BrowserLoggerOptions = NonNullable<LoggerOptions['browser']>;

const isBrowserEnvironment =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
  SILENT = 'silent',
}

type ActiveLogLevel =
  | LogLevel.TRACE
  | LogLevel.DEBUG
  | LogLevel.INFO
  | LogLevel.WARN
  | LogLevel.ERROR
  | LogLevel.FATAL;

type LogMethodName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const ACTIVE_LEVELS: readonly ActiveLogLevel[] = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
];

const METHOD_BY_LEVEL: Partial<Record<LogLevel, LogMethodName>> = {
  [LogLevel.TRACE]: 'trace',
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.FATAL]: 'fatal',
};

export interface ConsoleTransportConfig {
  enabled?: boolean;
  level?: LogLevel;
  destination?: number | string;
  target?: string;
  options?: Record<string, unknown>;
}

export interface FileTransportConfig {
  enabled?: boolean;
  destination: string;
  level?: LogLevel;
  mkdir?: boolean;
  append?: boolean;
  options?: Record<string, unknown>;
}

export interface CustomTransportConfig {
  target: string;
  level?: LogLevel;
  options?: Record<string, unknown>;
}

export interface LoggerConfig {
  level?: LogLevel;
  enableInProduction?: boolean;
  prefix?: string;
  includeTimestamp?: boolean;
  scopeKey?: string;
  baseBindings?: Record<string, unknown>;
  console?: ConsoleTransportConfig | false;
  file?: FileTransportConfig | false;
  customTransports?: readonly CustomTransportConfig[];
  browser?: BrowserLoggerOptions;
  redactPaths?: readonly string[];
}

export interface LogRecord {
  level: LogLevel;
  scope?: string;
  message?: string;
  timestamp: number;
  args: readonly unknown[];
  bindings: Record<string, unknown>;
}

export type LogListener = (record: LogRecord) => void;

interface NormalizedConsoleConfig {
  enabled: boolean;
  level?: LogLevel;
  destination?: number | string;
  target?: string;
  options: Record<string, unknown>;
}

interface NormalizedFileConfig {
  enabled: boolean;
  destination: string;
  level?: LogLevel;
  mkdir: boolean;
  append: boolean;
  options: Record<string, unknown>;
}

interface InternalLoggerConfig {
  explicitLevel?: LogLevel;
  enableInProduction: boolean;
  prefix?: string;
  includeTimestamp: boolean;
  scopeKey: string;
  baseBindings: Record<string, unknown>;
  console: NormalizedConsoleConfig;
  file?: NormalizedFileConfig;
  customTransports: readonly CustomTransportConfig[];
  browser?: BrowserLoggerOptions;
  redactPaths?: readonly string[];
}

let internalConfig: InternalLoggerConfig = createDefaultConfig();
let rootLogger: PinoLogger | undefined;
let currentLevel: LogLevel = resolveEffectiveLevel(internalConfig);
const scopedLoggers = new Map<string, PinoLogger>();
const logListeners = new Set<LogListener>();

function createDefaultConfig(): InternalLoggerConfig {
  return {
    enableInProduction: false,
    includeTimestamp: false,
    scopeKey: 'scope',
    baseBindings: {},
    console: {
      enabled: true,
      options: {},
    },
    customTransports: [],
  };
}

function resolveEffectiveLevel(config: InternalLoggerConfig): LogLevel {
  if (config.explicitLevel) {
    return config.explicitLevel;
  }

  if (isDevEnv() || config.enableInProduction) {
    return LogLevel.DEBUG;
  }

  return LogLevel.INFO;
}

function mergeConsoleConfig(
  previous: NormalizedConsoleConfig,
  next?: ConsoleTransportConfig | false
): NormalizedConsoleConfig {
  if (next === false) {
    return { ...previous, enabled: false };
  }

  if (!next) {
    return previous;
  }

  const merged: NormalizedConsoleConfig = {
    enabled: next.enabled ?? previous.enabled,
    options: next.options ? { ...previous.options, ...next.options } : { ...previous.options },
  };

  const effectiveLevel = next.level ?? previous.level;
  if (effectiveLevel !== undefined) {
    merged.level = effectiveLevel;
  }

  const effectiveDestination = next.destination ?? previous.destination;
  if (effectiveDestination !== undefined) {
    merged.destination = effectiveDestination;
  }

  const effectiveTarget = next.target ?? previous.target;
  if (effectiveTarget !== undefined) {
    merged.target = effectiveTarget;
  }

  return merged;
}

function mergeFileConfig(
  previous: NormalizedFileConfig | undefined,
  next?: FileTransportConfig | false
): NormalizedFileConfig | undefined {
  if (next === false) {
    return undefined;
  }

  if (!next) {
    return previous;
  }

  const baseOptions = previous ? { ...previous.options } : {};
  const resolved: NormalizedFileConfig = {
    enabled: next.enabled ?? previous?.enabled ?? true,
    destination: next.destination,
    mkdir: next.mkdir ?? previous?.mkdir ?? true,
    append: next.append ?? previous?.append ?? true,
    options: next.options ? { ...baseOptions, ...next.options } : baseOptions,
  };

  const effectiveLevel = next.level ?? previous?.level;
  if (effectiveLevel !== undefined) {
    resolved.level = effectiveLevel;
  }

  return resolved;
}

function resolveBaseBindings(
  config: InternalLoggerConfig,
  scope?: string
): Record<string, unknown> {
  const bindings: Record<string, unknown> = { ...config.baseBindings };

  if (config.prefix) {
    bindings['prefix'] = config.prefix;
  }

  if (scope) {
    bindings[config.scopeKey] = scope;
  }

  return bindings;
}

function rebuildRootLogger(): void {
  if (rootLogger && typeof rootLogger.flush === 'function') {
    rootLogger.flush();
  }

  rootLogger = undefined;
  scopedLoggers.clear();
  currentLevel = resolveEffectiveLevel(internalConfig);
}

function ensureRootLogger(): PinoLogger {
  if (!rootLogger) {
    rootLogger = createRootLogger();
  }

  return rootLogger;
}

function createRootLogger(): PinoLogger {
  const resolvedLevel = currentLevel;
  const baseOptions: LoggerOptions = {
    level: resolvedLevel,
    base: resolveBaseBindings(internalConfig),
    timestamp: internalConfig.includeTimestamp ? pino.stdTimeFunctions.isoTime : false,
  };

  if (internalConfig.redactPaths) {
    baseOptions.redact = Array.from(internalConfig.redactPaths);
  }

  if (internalConfig.browser) {
    baseOptions.browser = internalConfig.browser;
  }

  let destination: DestinationStream | undefined;

  if (!isBrowserEnvironment) {
    const targets = buildTransportTargets(resolvedLevel);

    if (targets.length > 0) {
      destination = transport({ targets });
    }
  }

  const logger = destination ? pino(baseOptions, destination) : pino(baseOptions);
  logger.level = resolvedLevel;
  return logger;
}

function buildTransportTargets(level: LogLevel): TransportTargetOptions<Record<string, unknown>>[] {
  const targets: TransportTargetOptions<Record<string, unknown>>[] = [];

  if (internalConfig.console.enabled) {
    targets.push(createConsoleTransportTarget(level));
  }

  if (internalConfig.file?.enabled) {
    targets.push(createFileTransportTarget(level));
  }

  for (const transportConfig of internalConfig.customTransports) {
    const options = transportConfig.options ? { ...transportConfig.options } : {};
    targets.push({
      target: transportConfig.target,
      level: transportConfig.level ?? level,
      options,
    });
  }

  return targets;
}

function createConsoleTransportTarget(
  level: LogLevel
): TransportTargetOptions<Record<string, unknown>> {
  const consoleConfig = internalConfig.console;
  const options: Record<string, unknown> = { ...consoleConfig.options };

  if (consoleConfig.destination !== undefined) {
    options['destination'] = consoleConfig.destination;
  } else if (!consoleConfig.target) {
    options['destination'] = 1;
  }

  return {
    target: consoleConfig.target ?? 'pino/file',
    level: consoleConfig.level ?? level,
    options,
  };
}

function createFileTransportTarget(
  level: LogLevel
): TransportTargetOptions<Record<string, unknown>> {
  const fileConfig = internalConfig.file as NormalizedFileConfig;
  return {
    target: 'pino/file',
    level: fileConfig.level ?? level,
    options: {
      destination: fileConfig.destination,
      mkdir: fileConfig.mkdir,
      append: fileConfig.append,
      ...fileConfig.options,
    },
  };
}

function isLevelEnabled(level: LogLevel): boolean {
  if (level === LogLevel.SILENT) {
    return false;
  }

  if (currentLevel === LogLevel.SILENT) {
    return false;
  }

  const currentIndex = ACTIVE_LEVELS.indexOf(currentLevel as ActiveLogLevel);
  if (currentIndex === -1) {
    return true;
  }

  const candidateIndex = ACTIVE_LEVELS.indexOf(level as ActiveLogLevel);
  if (candidateIndex === -1) {
    return true;
  }

  return candidateIndex >= currentIndex;
}

function getLoggerForScope(scope?: string): PinoLogger {
  if (!scope) {
    return ensureRootLogger();
  }

  const cached = scopedLoggers.get(scope);
  if (cached) {
    return cached;
  }

  const childBindings: Record<string, string> = {
    [internalConfig.scopeKey]: scope,
  };
  const child = ensureRootLogger().child(childBindings);
  scopedLoggers.set(scope, child);
  return child;
}

function emitLogRecord(level: LogLevel, scope: string | undefined, args: readonly unknown[]): void {
  if (logListeners.size === 0) {
    return;
  }

  const bindings = resolveBaseBindings(internalConfig, scope);
  const [first] = args;
  const message = typeof first === 'string' ? first : undefined;
  const argsCopy = [...args];
  const record: LogRecord = {
    level,
    timestamp: Date.now(),
    args: argsCopy,
    bindings,
    ...(scope ? { scope } : {}),
    ...(message ? { message } : {}),
  };

  for (const listener of logListeners) {
    try {
      listener(record);
    } catch {
      // Listener errors must not break logging
    }
  }
}

type PinoLogMethod = (first: unknown, ...rest: unknown[]) => void;

function logInternal(level: LogLevel, scope: string | undefined, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) {
    return;
  }

  const methodName = METHOD_BY_LEVEL[level];
  if (!methodName) {
    return;
  }

  const target = getLoggerForScope(scope);
  const logMethod = target[methodName] as unknown as PinoLogMethod;

  if (args.length === 0) {
    logMethod.call(target, '');
  } else {
    const [first, ...rest] = args;
    logMethod.call(target, first, ...rest);
  }

  emitLogRecord(level, scope, args);
}

export function configureLogger(config: LoggerConfig): void {
  const mergedConsole = mergeConsoleConfig(internalConfig.console, config.console);
  const mergedFile = mergeFileConfig(internalConfig.file, config.file);

  const baseConfig: InternalLoggerConfig = {
    ...internalConfig,
    console: mergedConsole,
    customTransports: config.customTransports ?? internalConfig.customTransports,
  };

  const nextConfig: InternalLoggerConfig = mergedFile
    ? { ...baseConfig, file: mergedFile }
    : (({ file: _removed, ...rest }) => rest as InternalLoggerConfig)(baseConfig);

  if (config.level !== undefined) {
    nextConfig.explicitLevel = config.level;
  }

  if (config.enableInProduction !== undefined) {
    nextConfig.enableInProduction = config.enableInProduction;
  }

  if (config.prefix !== undefined) {
    nextConfig.prefix = config.prefix;
  }

  if (config.includeTimestamp !== undefined) {
    nextConfig.includeTimestamp = config.includeTimestamp;
  }

  if (config.scopeKey !== undefined) {
    nextConfig.scopeKey = config.scopeKey;
  }

  if (config.baseBindings) {
    nextConfig.baseBindings = {
      ...nextConfig.baseBindings,
      ...config.baseBindings,
    };
  }

  if (config.browser !== undefined) {
    nextConfig.browser = config.browser;
  }

  if (config.redactPaths !== undefined) {
    nextConfig.redactPaths = config.redactPaths;
  }

  internalConfig = nextConfig;

  rebuildRootLogger();
}

export function setLogLevel(level: LogLevel): void {
  internalConfig = {
    ...internalConfig,
    explicitLevel: level,
  };

  currentLevel = level;

  if (rootLogger) {
    rootLogger.level = level;
  }
}

export function resetLogger(): void {
  internalConfig = createDefaultConfig();
  currentLevel = resolveEffectiveLevel(internalConfig);
  rebuildRootLogger();
}

export function debug(...args: unknown[]): void {
  logInternal(LogLevel.DEBUG, undefined, args);
}

export function info(...args: unknown[]): void {
  logInternal(LogLevel.INFO, undefined, args);
}

export function warn(...args: unknown[]): void {
  logInternal(LogLevel.WARN, undefined, args);
}

export function error(...args: unknown[]): void {
  logInternal(LogLevel.ERROR, undefined, args);
}

export function createLogger(scope: string): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  return {
    debug: (...args: unknown[]) => logInternal(LogLevel.DEBUG, scope, args),
    info: (...args: unknown[]) => logInternal(LogLevel.INFO, scope, args),
    warn: (...args: unknown[]) => logInternal(LogLevel.WARN, scope, args),
    error: (...args: unknown[]) => logInternal(LogLevel.ERROR, scope, args),
  };
}

export function addLogListener(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

export const log = debug;
export const logInfo = info;
export const logError = error;
export const logWarn = warn;
