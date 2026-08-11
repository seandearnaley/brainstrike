import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { serializeDiagnosticJson } from './log-diagnostic-metadata';

const BINDINGS_SERIALIZATION_FAILURE = '[Bindings serialization failed]';

export function sortLogRecords(records: readonly LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => a.timestamp - b.timestamp);
}

export function formatLogTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      fractionalSecondDigits: 3,
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

export function serializeArgs(args?: readonly unknown[]): string {
  if (!args || args.length === 0) {
    return '';
  }
  return args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

export function serializeBindings(bindings: LogRecord['bindings']): string {
  try {
    // Preserve normal JSON/toJSON semantics on the common path; only invoke the
    // diagnostic normalizer when native serialization proves the value unsafe.
    const serialized = JSON.stringify(bindings ?? {});
    return serialized ?? BINDINGS_SERIALIZATION_FAILURE;
  } catch {
    try {
      return serializeDiagnosticJson(
        bindings ?? {},
        'Log bindings',
        0,
        BINDINGS_SERIALIZATION_FAILURE
      );
    } catch {
      return BINDINGS_SERIALIZATION_FAILURE;
    }
  }
}

export function getLevelBadgeVariant(
  level: LogLevel
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (level) {
    case LogLevel.ERROR:
    case LogLevel.FATAL:
      return 'destructive';
    case LogLevel.WARN:
      return 'default'; // Changed to default (usually primary color) for visibility
    case LogLevel.INFO:
      return 'secondary';
    case LogLevel.DEBUG:
    case LogLevel.TRACE:
      return 'outline';
    default:
      return 'outline';
  }
}

export interface LogRecordRow extends LogRecord {
  flattenedBindings: string;
  originalRecord: LogRecord;
  serializedArgs: string;
}

export const MAX_CACHED_LOG_SEARCH_HAYSTACK_CHARACTERS = 4 * 1024 * 1024;

export interface LogSearchHaystackCache {
  cachedCharacters: number;
  haystacks: WeakMap<LogRecord, string>;
  resetFor: (records: readonly LogRecord[]) => void;
}

export function createLogSearchHaystackCache(): LogSearchHaystackCache {
  let records: readonly LogRecord[] | undefined;
  const cache: LogSearchHaystackCache = {
    cachedCharacters: 0,
    haystacks: new WeakMap<LogRecord, string>(),
    resetFor(nextRecords: readonly LogRecord[]): void {
      if (records === nextRecords) {
        return;
      }
      records = nextRecords;
      cache.cachedCharacters = 0;
      cache.haystacks = new WeakMap<LogRecord, string>();
    },
  };
  return cache;
}

export function getCachedLogSearchHaystack(
  row: LogRecordRow,
  cache: LogSearchHaystackCache
): string {
  const cachedHaystack = cache.haystacks.get(row.originalRecord);
  if (cachedHaystack !== undefined) {
    return cachedHaystack;
  }
  const haystack = [row.message ?? '', row.scope ?? '', row.serializedArgs, row.flattenedBindings]
    .join(' ')
    .toLowerCase();
  if (cache.cachedCharacters + haystack.length <= MAX_CACHED_LOG_SEARCH_HAYSTACK_CHARACTERS) {
    cache.haystacks.set(row.originalRecord, haystack);
    cache.cachedCharacters += haystack.length;
  }
  return haystack;
}
