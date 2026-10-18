import type {
  DestinationStream,
  LoggerOptions,
  Logger as PinoLogger,
  TransportTargetOptions,
} from 'pino';
import pino from 'pino';
import { isErrorObject, logSerializers } from './log-serializers.js';

type BrowserLoggerOptions = NonNullable<LoggerOptions['browser']>;
type ManagedNodeDestination = DestinationStream & {
  readonly destroyed?: boolean;
  end: () => void;
  flushSync: () => void;
};

/**
 * Detect if we're in a browser-like environment (browser or Web Worker).
 * Web Workers don't have `window`, but they have `self` with `postMessage`.
 * Both should use pino's browser mode, not Node.js transports.
 */
const isWorkerEnvironment =
  typeof self !== 'undefined' &&
  typeof (self as { postMessage?: unknown }).postMessage === 'function' &&
  typeof window === 'undefined';

const isBrowserEnvironment =
  (typeof window !== 'undefined' && typeof window.document !== 'undefined') || isWorkerEnvironment;

// biome-ignore lint/style/noEnum: Widely used enum with string values - refactoring would be breaking change
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

function isLevelEnabledAtThreshold(level: LogLevel, threshold: LogLevel): boolean {
  if (level === LogLevel.SILENT || threshold === LogLevel.SILENT) {
    return false;
  }

  const thresholdIndex = ACTIVE_LEVELS.indexOf(threshold as ActiveLogLevel);
  if (thresholdIndex === -1) {
    return true;
  }

  const candidateIndex = ACTIVE_LEVELS.indexOf(level as ActiveLogLevel);
  if (candidateIndex === -1) {
    return true;
  }

  return candidateIndex >= thresholdIndex;
}

export interface ConsoleTransportConfig {
  destination?: number | string;
  enabled?: boolean;
  level?: LogLevel;
  options?: Record<string, unknown>;
  target?: string;
}

export interface FileTransportConfig {
  append?: boolean;
  destination: string;
  enabled?: boolean;
  level?: LogLevel;
  mkdir?: boolean;
  options?: Record<string, unknown>;
  target?: string;
}

export interface CustomTransportConfig {
  level?: LogLevel;
  options?: Record<string, unknown>;
  target: string;
}

export interface LoggerConfig {
  baseBindings?: Record<string, unknown>;
  browser?: BrowserLoggerOptions;
  console?: ConsoleTransportConfig | false;
  customTransports?: readonly CustomTransportConfig[];
  file?: FileTransportConfig | false;
  includeTimestamp?: boolean;
  level?: LogLevel;
  prefix?: string;
  redactPaths?: readonly string[];
  scopeKey?: string;
}

export interface LogRecord {
  args: readonly unknown[];
  bindings: Record<string, unknown>;
  level: LogLevel;
  message?: string;
  scope?: string;
  timestamp: number;
}

export type LogListener = (record: LogRecord) => void;

interface NormalizedConsoleConfig {
  destination?: number | string;
  enabled: boolean;
  level?: LogLevel;
  options: Record<string, unknown>;
  target?: string;
}

interface NormalizedFileConfig {
  append: boolean;
  destination: string;
  enabled: boolean;
  level?: LogLevel;
  mkdir: boolean;
  options: Record<string, unknown>;
  target?: string;
}

interface InternalLoggerConfig {
  baseBindings: Record<string, unknown>;
  browser?: BrowserLoggerOptions;
  console: NormalizedConsoleConfig;
  customTransports: readonly CustomTransportConfig[];
  explicitLevel?: LogLevel;
  file?: NormalizedFileConfig;
  includeTimestamp: boolean;
  prefix?: string;
  redactPaths?: readonly string[];
  scopeKey: string;
}

let internalConfig: InternalLoggerConfig = createDefaultConfig();
let rootLogger: PinoLogger | undefined;
let activeNodeDestination: ManagedNodeDestination | undefined;
let currentLevel: LogLevel = resolveEffectiveLevel(internalConfig);
const scopedLoggers = new Map<string, PinoLogger>();
const logListeners = new Set<LogListener>();

function createDefaultConfig(): InternalLoggerConfig {
  return {
    baseBindings: {},
    console: {
      enabled: true,
      options: {},
    },
    customTransports: [],
    includeTimestamp: false,
    scopeKey: 'scope',
  };
}

function parseEnvLogLevel(): LogLevel | undefined {
  const envLevel = typeof process === 'undefined' ? undefined : process.env?.['LOG_LEVEL'];
  if (!envLevel) {
    return;
  }

  const upperLevel = envLevel.toUpperCase() as keyof typeof LogLevel;
  return LogLevel[upperLevel];
}

function resolveEffectiveLevel(config: InternalLoggerConfig): LogLevel {
  if (config.explicitLevel) {
    return config.explicitLevel;
  }

  const envLevel = parseEnvLogLevel();
  if (envLevel) {
    return envLevel;
  }

  // INFO is the environment-independent default. Runtime initialization may
  // still opt into a different explicit level, and LOG_LEVEL remains the
  // process-level override.
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
    return;
  }

  if (!next) {
    return previous;
  }

  const baseOptions = previous ? { ...previous.options } : {};
  const resolved: NormalizedFileConfig = {
    append: next.append ?? previous?.append ?? true,
    destination: next.destination,
    enabled: next.enabled ?? previous?.enabled ?? true,
    mkdir: next.mkdir ?? previous?.mkdir ?? true,
    options: next.options ? { ...baseOptions, ...next.options } : baseOptions,
  };

  const effectiveLevel = next.level ?? previous?.level;
  if (effectiveLevel !== undefined) {
    resolved.level = effectiveLevel;
  }
  const effectiveTarget = next.target ?? previous?.target;
  if (effectiveTarget !== undefined) {
    resolved.target = effectiveTarget;
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

  return redactSensitiveLogValue(bindings) as Record<string, unknown>;
}

type BrowserConsoleMethodName = 'debug' | 'error' | 'info' | 'trace' | 'warn';

const BROWSER_CONSOLE_METHOD_BY_LEVEL: Readonly<
  Record<LogMethodName | 'fatal', BrowserConsoleMethodName>
> = {
  debug: 'debug',
  error: 'error',
  fatal: 'error',
  info: 'info',
  trace: 'trace',
  warn: 'warn',
};

function sanitizeBrowserConsoleValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  if (value instanceof URL) {
    return value.toString();
  }

  // Functions are not log data. Pino's browser redaction also leaves a
  // `restore()` method on every redacted record, which printed as source text
  // on each console line (BST-2154).
  if (typeof value === 'function') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBrowserConsoleValue(entry, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const sanitizedEntries = Object.entries(value).map(([key, entry]) => [
      key,
      sanitizeBrowserConsoleValue(entry, seen),
    ]);
    return Object.fromEntries(sanitizedEntries);
  }

  return String(value);
}

function stringifyBrowserConsoleMetadata(metadata: Record<string, unknown>): string | null {
  const sanitizedMetadata = sanitizeBrowserConsoleValue(metadata);
  if (
    !sanitizedMetadata ||
    typeof sanitizedMetadata !== 'object' ||
    Array.isArray(sanitizedMetadata)
  ) {
    return null;
  }

  const entries = Object.entries(sanitizedMetadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}

function formatBrowserConsoleMessage(
  value: unknown,
  scopeKey: string,
  baseBindings: Record<string, unknown>
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return String(value);
  }

  const record = value as Record<string, unknown>;
  const message =
    typeof record['msg'] === 'string' && record['msg'].length > 0 ? record['msg'] : null;
  const scopeValue = record[scopeKey];
  const scope = typeof scopeValue === 'string' && scopeValue.length > 0 ? scopeValue : null;

  const metadata = Object.fromEntries(
    Object.entries(record).filter(([key]) => {
      if (key === 'level' || key === 'msg' || key === 'time' || key === scopeKey) {
        return false;
      }
      if (key in baseBindings) {
        return false;
      }
      return true;
    })
  );

  const prefix = scope ? `[${scope}] ` : '';
  const messageText = message ?? '';
  const metadataText = stringifyBrowserConsoleMetadata(metadata);

  if (messageText && metadataText) {
    return `${prefix}${messageText} ${metadataText}`;
  }
  if (messageText) {
    return `${prefix}${messageText}`;
  }
  if (metadataText) {
    return `${prefix}${metadataText}`;
  }
  return prefix.trim().length > 0 ? prefix.trim() : String(value);
}

function createBrowserWrite(
  config: InternalLoggerConfig
): NonNullable<BrowserLoggerOptions['write']> {
  const baseBindings = resolveBaseBindings(config);
  const consoleThreshold = config.console.level ?? resolveEffectiveLevel(config);
  const writeMethod = (level: LogMethodName | 'fatal') => (value: unknown) => {
    const globalConsole = typeof console === 'undefined' ? null : console;
    const logLevel = level === 'fatal' ? LogLevel.FATAL : (level as LogLevel);
    if (
      !(
        globalConsole &&
        config.console.enabled &&
        isLevelEnabledAtThreshold(logLevel, consoleThreshold)
      )
    ) {
      return;
    }

    const consoleMethodName = BROWSER_CONSOLE_METHOD_BY_LEVEL[level];
    const consoleMethod =
      typeof globalConsole[consoleMethodName] === 'function'
        ? globalConsole[consoleMethodName]
        : globalConsole.log;

    consoleMethod.call(
      globalConsole,
      formatBrowserConsoleMessage(value, config.scopeKey, baseBindings)
    );
  };

  return {
    debug: writeMethod('debug'),
    error: writeMethod('error'),
    fatal: writeMethod('fatal'),
    info: writeMethod('info'),
    trace: writeMethod('trace'),
    warn: writeMethod('warn'),
  };
}

function drainNodeDestination(destination: ManagedNodeDestination): void {
  if (destination.destroyed) {
    return;
  }
  destination.flushSync();
  destination.end();
}

function requireManagedNodeDestination(destination: DestinationStream): ManagedNodeDestination {
  const candidate = destination as DestinationStream &
    Partial<Pick<ManagedNodeDestination, 'end' | 'flushSync'>>;
  if (typeof candidate.flushSync !== 'function' || typeof candidate.end !== 'function') {
    throw new Error('pino transport does not expose the required synchronous drain lifecycle');
  }
  return candidate as ManagedNodeDestination;
}

function rebuildRootLogger(): void {
  if (activeNodeDestination) {
    drainNodeDestination(activeNodeDestination);
    activeNodeDestination = undefined;
  } else if (rootLogger && typeof rootLogger.flush === 'function') {
    // Flush any pending logs before rebuilding
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
    base: resolveBaseBindings(internalConfig),
    level: resolvedLevel,
    serializers: logSerializers,
    timestamp: internalConfig.includeTimestamp ? pino.stdTimeFunctions.isoTime : false,
  };

  if (internalConfig.redactPaths) {
    baseOptions.redact = Array.from(internalConfig.redactPaths);
  }

  if (isBrowserEnvironment) {
    const browserWrite: NonNullable<BrowserLoggerOptions['write']> =
      internalConfig.browser?.write ?? createBrowserWrite(internalConfig);
    const defaultBrowserOptions: BrowserLoggerOptions = {
      asObject: true,
      serialize: true,
      write: browserWrite,
    };
    const { write: _ignoredWrite, ...browserOverrides } = internalConfig.browser ?? {};
    baseOptions.browser = {
      ...defaultBrowserOptions,
      ...browserOverrides,
      write: browserWrite,
    };
  }

  let destination: DestinationStream | undefined;

  if (!isBrowserEnvironment) {
    const targets = buildTransportTargets(resolvedLevel);

    if (targets.length > 0) {
      const nodeTransport = resolveNodeTransport();
      const [singleTarget] = targets;
      // An inherited threshold is already enforced by the logger. Pino's
      // single-target form also preserves the direct transport lifecycle.
      const transport =
        targets.length === 1 && singleTarget?.level === resolvedLevel
          ? nodeTransport({
              ...(singleTarget.options === undefined ? {} : { options: singleTarget.options }),
              target: singleTarget.target,
            })
          : nodeTransport({ targets });
      // A closed parent pipe destroyed the M3 Windows proof's transport; logging
      // its uncaught error back into that worker recursively queued more errors.
      // Pino owns transport failure: observe it through its documented event.
      // https://github.com/pinojs/pino/blob/main/docs/transports.md#error-messages
      transport.on('error', (error: Error) => {
        logInternal(LogLevel.ERROR, 'Logger', [{ error }, 'Log transport failed']);
      });
      destination = transport;
    }
  }

  const transportEnabled = destination !== undefined || isBrowserEnvironment;
  const logger = destination
    ? pino(baseOptions, destination)
    : pino({
        ...baseOptions,
        enabled: transportEnabled,
      });
  activeNodeDestination = destination ? requireManagedNodeDestination(destination) : undefined;
  // Pino implements `enabled: false` by coercing the logger level to `silent`.
  // Reassigning `.level` for a transport-free Node logger would re-enable Pino's
  // implicit stdout destination and defeat the explicit console opt-out above.
  if (transportEnabled) {
    logger.level = resolvedLevel;
  }
  return logger;
}

function resolveNodeTransport(): typeof import('pino')['transport'] {
  const maybeTransport = (
    pino as typeof pino & {
      transport?: typeof import('pino')['transport'];
    }
  ).transport;

  if (!maybeTransport) {
    throw new Error('pino transport is not available in this environment');
  }

  return maybeTransport;
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
      level: transportConfig.level ?? level,
      options,
      target: transportConfig.target,
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
    level: consoleConfig.level ?? level,
    options,
    target: consoleConfig.target ?? 'pino/file',
  };
}

function createFileTransportTarget(
  level: LogLevel
): TransportTargetOptions<Record<string, unknown>> {
  const fileConfig = internalConfig.file as NormalizedFileConfig;
  return {
    level: fileConfig.level ?? level,
    options: {
      append: fileConfig.append,
      destination: fileConfig.destination,
      mkdir: fileConfig.mkdir,
      ...fileConfig.options,
    },
    target: fileConfig.target ?? 'pino/file',
  };
}

function isLevelEnabled(level: LogLevel): boolean {
  return isLevelEnabledAtThreshold(level, currentLevel);
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

function resolveLogRecordMessage(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === 'string' && arg.length > 0) {
      return arg;
    }
  }
  return;
}

function isSensitiveLogKey(key: string, path: readonly string[]): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const configured =
    internalConfig.redactPaths?.some((redactPath) => {
      const parts = redactPath
        .match(/[^.[\]]+|\[([^[\]]*?)\]/g)
        ?.map((segment) => segment.replace(/^\[['"`]?|['"`]?\]$/g, ''));
      return (
        parts?.length === path.length && parts.every((part, i) => part === '*' || part === path[i])
      );
    }) === true;
  return configured || /apikey|authorization|cookie|password|secret|token$/.test(normalized);
}

export function redactSensitiveLogValue(
  value: unknown,
  path: readonly string[] = [],
  seen = new WeakMap<object, unknown>(),
  options: {
    readonly maxDepth?: number;
    readonly onDepthTruncated?: () => void;
    readonly onRepeatedValue?: () => void;
    readonly repeatedValue?: string;
  } = {}
): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (path.length >= (options.maxDepth ?? Number.POSITIVE_INFINITY)) {
    options.onDepthTruncated?.();
    return '[TRUNCATED: maximum diagnostic depth]';
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    options.onRepeatedValue?.();
    return options.repeatedValue ?? existing;
  }
  const redacted = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
  // Memoize BEFORE any recursion (including the Error-cause walk below): a
  // cyclic cause chain (err.cause === err, or mutual A<->B) must hit the
  // WeakMap and terminate — recursing first would loop forever.
  seen.set(value, redacted);
  // Shares the serializer's Error-object test rather than `instanceof Error`,
  // so a cross-realm Error is not stripped here — before the (wider) serializer
  // gate downstream ever sees it (BST-1662).
  if (isErrorObject(value)) {
    Object.assign(redacted, { message: value.message, name: value.name, stack: value.stack });
    // `Error.cause` is a non-enumerable own property, so the `Object.entries`
    // walk below never visits it — without this, the cause chain silently
    // disappears the moment an Error is redacted (see diagnostic-events.ts,
    // which relies on `cause` surviving to walk it back out).
    if (value.cause !== undefined) {
      redacted['cause'] = redactSensitiveLogValue(value.cause, [...path, 'cause'], seen, options);
    }
    // AggregateError.errors is also non-enumerable. Keep every independent
    // failure on the same recursive redaction path before Pino serializes it.
    if ('errors' in value && Array.isArray(value.errors)) {
      const errorsPath = [...path, 'errors'];
      redacted['errors'] = isSensitiveLogKey('errors', errorsPath)
        ? '[REDACTED]'
        : redactSensitiveLogValue(value.errors, errorsPath, seen, options);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    redacted[key] = isSensitiveLogKey(key, entryPath)
      ? '[REDACTED]'
      : redactSensitiveLogValue(entry, entryPath, seen, options);
  }
  return redacted;
}

function emitLogRecord(level: LogLevel, scope: string | undefined, args: readonly unknown[]): void {
  if (logListeners.size === 0) {
    return;
  }

  const bindings = resolveBaseBindings(internalConfig, scope);
  const message = resolveLogRecordMessage(args);
  const record: LogRecord = {
    args,
    bindings,
    level,
    timestamp: Date.now(),
    ...(scope ? { scope } : {}),
    ...(message ? { message } : {}),
  };

  for (const listener of logListeners) {
    try {
      listener(record);
    } catch (listenerError) {
      // Listener errors must not break logging, but we should report them
      if (console?.error) {
        console.error('[Logger] Listener error:', listenerError);
      }
    }
  }
}

type PinoLogMethod = (first: unknown, ...rest: unknown[]) => void;

const PRINTF_DIRECTIVE = /%[sdifjoOc%]/;

function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePinoLogArgs(args: readonly unknown[]): readonly unknown[] {
  const [message, metadata, error] = args;
  if (typeof message !== 'string' || !isMetadataObject(metadata)) {
    return args;
  }
  // Public Brainstrike logging is message-first, while Pino's structured form
  // is object-first. Reorder only the declared `(message, metadata)` overload;
  // other variadic calls retain Pino's interpolation semantics.
  if (args.length === 2) {
    return [metadata, message];
  }
  // `(message, metadata, error)` without placeholders: Pino would interpolate
  // the message and drop both trailing arguments, so the sinks kept only the
  // message (BST-2154). Fold the error into the metadata instead.
  if (args.length === 3 && !PRINTF_DIRECTIVE.test(message)) {
    return [{ ...metadata, error }, message];
  }
  return args;
}

function writePinoLog(
  logMethod: PinoLogMethod,
  target: PinoLogger,
  args: readonly unknown[]
): void {
  if (args.length === 0) {
    logMethod.call(target, '');
    return;
  }
  const [first, ...rest] = args;
  logMethod.call(target, first, ...rest);
}

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
  const safeArgs = args.map((arg) => redactSensitiveLogValue(arg));
  const pinoArgs = normalizePinoLogArgs(safeArgs);

  try {
    if (!activeNodeDestination?.destroyed) {
      writePinoLog(logMethod, target, pinoArgs);
    }
  } catch (logError) {
    // Some tooling (React DevTools) patches console methods and can throw runtime
    // exceptions when inspecting complex payloads. Logging must never break app flow.
    if (typeof window === 'undefined' || !('__REACT_DEVTOOLS_GLOBAL_HOOK__' in window)) {
      throw logError;
    }
  }

  emitLogRecord(level, scope, safeArgs);
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

  rebuildRootLogger();
}

export function resetLogger(): void {
  internalConfig = createDefaultConfig();
  currentLevel = resolveEffectiveLevel(internalConfig);
  rebuildRootLogger();
}

// Type-safe overloads for structured logging
export function trace(message: string, data?: Record<string, unknown>): void;
export function trace(...args: unknown[]): void;
export function trace(...args: unknown[]): void {
  logInternal(LogLevel.TRACE, undefined, args);
}

export function debug(message: string, data?: Record<string, unknown>): void;
export function debug(...args: unknown[]): void;
export function debug(...args: unknown[]): void {
  logInternal(LogLevel.DEBUG, undefined, args);
}

export function info(message: string, data?: Record<string, unknown>): void;
export function info(...args: unknown[]): void;
export function info(...args: unknown[]): void {
  logInternal(LogLevel.INFO, undefined, args);
}

export function warn(message: string, data?: Record<string, unknown>): void;
export function warn(...args: unknown[]): void;
export function warn(...args: unknown[]): void {
  logInternal(LogLevel.WARN, undefined, args);
}

export function error(message: string, data?: Record<string, unknown>): void;
export function error(...args: unknown[]): void;
export function error(...args: unknown[]): void {
  logInternal(LogLevel.ERROR, undefined, args);
}

export function fatal(message: string, data?: Record<string, unknown>): void;
export function fatal(...args: unknown[]): void;
export function fatal(...args: unknown[]): void {
  logInternal(LogLevel.FATAL, undefined, args);
}

export interface ScopedLogger {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const loggerCache = new Map<string, ScopedLogger>();

export function createLogger(scope: string): ScopedLogger {
  const cached = loggerCache.get(scope);
  if (cached) {
    return cached;
  }

  const logger: ScopedLogger = {
    debug: (...args: unknown[]) => logInternal(LogLevel.DEBUG, scope, args),
    error: (...args: unknown[]) => logInternal(LogLevel.ERROR, scope, args),
    fatal: (...args: unknown[]) => logInternal(LogLevel.FATAL, scope, args),
    info: (...args: unknown[]) => logInternal(LogLevel.INFO, scope, args),
    trace: (...args: unknown[]) => logInternal(LogLevel.TRACE, scope, args),
    warn: (...args: unknown[]) => logInternal(LogLevel.WARN, scope, args),
  };

  loggerCache.set(scope, logger);
  return logger;
}

export function addLogListener(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

export const __loggerTesting = {
  createBrowserWrite,
  drainNodeDestination,
  formatBrowserConsoleMessage,
  isRootTransportEnabled: () => ensureRootLogger().isLevelEnabled(currentLevel),
  normalizePinoLogArgs,
  sanitizeBrowserConsoleValue,
  serializers: logSerializers,
  writePinoLog,
};

export const log = debug;
export const logInfo = info;
export const logError = error;
export const logWarn = warn;
