import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';

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
  serializedArgs: string;
}
