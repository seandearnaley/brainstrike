import type { DiagnosticCauseEntry } from '@brainstrike/utils/diagnostics';
import type { LogRecord } from '@brainstrike/utils/logger';

const CIRCULAR_REFERENCE_MARKER = '[Circular]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isCauseEntry(value: unknown): value is DiagnosticCauseEntry {
  if (!isRecord(value)) {
    return false;
  }
  const code = value['code'];
  return (
    typeof value['message'] === 'string' &&
    typeof value['name'] === 'string' &&
    (code === undefined || typeof code === 'string')
  );
}

export function getLogRecordContext(record: LogRecord): Record<string, unknown> | null {
  for (const arg of record.args.toReversed()) {
    if (isRecord(arg)) {
      return arg;
    }
  }
  return null;
}

export function getLogRecordSource(record: LogRecord): string {
  const explicitSource = readNonEmptyString(getLogRecordContext(record)?.['logSource']);
  if (explicitSource) {
    return explicitSource;
  }
  return readNonEmptyString(record.bindings['runtime']) ?? 'unknown';
}

export function getLogRecordCode(record: LogRecord): string | null {
  return (
    readNonEmptyString(record.bindings['code']) ??
    readNonEmptyString(getLogRecordContext(record)?.['code'])
  );
}

export function getLogRecordFingerprint(record: LogRecord): string | null {
  return readNonEmptyString(record.bindings['fingerprint']);
}

export function getLogRecordCauseChain(record: LogRecord): readonly DiagnosticCauseEntry[] {
  const causeChain = getLogRecordContext(record)?.['causeChain'];
  return Array.isArray(causeChain) && causeChain.every(isCauseEntry) ? causeChain : [];
}

export function getLogRecordStack(record: LogRecord): string | null {
  return readNonEmptyString(getLogRecordContext(record)?.['stack']);
}

/**
 * Produces valid, readable JSON for one viewer row. Logger records are normally
 * already JSON-safe, but session records can still carry Errors, bigint values,
 * or cycles. Those values are represented explicitly instead of crashing the
 * row action or silently dropping the copy.
 */
function serializeDiagnosticJson(value: unknown, description: string): string {
  const visited = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, value: unknown) => {
      if (typeof value === 'bigint') {
        return `${value}n`;
      }
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      if (visited.has(value)) {
        return CIRCULAR_REFERENCE_MARKER;
      }
      visited.add(value);
      if (value instanceof Error) {
        return {
          cause: value.cause,
          message: value.message,
          name: value.name,
          stack: value.stack,
        };
      }
      return value;
    },
    2
  );
  if (json === undefined) {
    throw new Error(`${description} could not be serialized as JSON`);
  }
  return json;
}

export function serializeLogContextJson(context: Record<string, unknown> | null): string {
  return serializeDiagnosticJson(context ?? {}, 'Log context');
}

export function serializeLogRecordJson(record: LogRecord): string {
  return serializeDiagnosticJson(record, 'Log record');
}
