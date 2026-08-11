import type { LogRecord } from '@brainstrike/logging';
import { type DiagnosticCauseEntry, isDiagnosticCauseEntry } from '@brainstrike/utils/diagnostics';

const CIRCULAR_REFERENCE_MARKER = '[Circular]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
  return readNonEmptyString(record.bindings?.['runtime']) ?? 'unknown';
}

export function getLogRecordCode(record: LogRecord): string | null {
  return (
    readNonEmptyString(record.bindings?.['code']) ??
    readNonEmptyString(getLogRecordContext(record)?.['code'])
  );
}

export function getLogRecordFingerprint(record: LogRecord): string | null {
  return readNonEmptyString(record.bindings?.['fingerprint']);
}

interface LogRecordCauseChainDiagnostics {
  entries: readonly DiagnosticCauseEntry[];
  malformedEntryCount: number;
}

export function getLogRecordCauseChainDiagnostics(
  record: LogRecord
): LogRecordCauseChainDiagnostics {
  const causeChain = getLogRecordContext(record)?.['causeChain'];
  if (causeChain === null || causeChain === undefined) {
    return { entries: [], malformedEntryCount: 0 };
  }
  if (!Array.isArray(causeChain)) {
    return { entries: [], malformedEntryCount: 1 };
  }

  const entries: DiagnosticCauseEntry[] = [];
  let malformedEntryCount = 0;
  for (const candidate of causeChain) {
    const normalizedCandidate =
      isRecord(candidate) && candidate['code'] === null
        ? { ...candidate, code: undefined }
        : candidate;
    if (!isDiagnosticCauseEntry(normalizedCandidate)) {
      malformedEntryCount += 1;
      continue;
    }
    const code = readNonEmptyString(normalizedCandidate.code);
    entries.push({
      ...(code ? { code } : {}),
      message: normalizedCandidate.message,
      name: normalizedCandidate.name,
    });
  }
  return { entries, malformedEntryCount };
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
function normalizeDiagnosticNumber(value: number): number | string {
  if (Number.isFinite(value)) {
    return value;
  }
  if (Number.isNaN(value)) {
    return '[NaN]';
  }
  return value > 0 ? '[Infinity]' : '[-Infinity]';
}

function normalizeDiagnosticValue(value: unknown, active: WeakSet<object>): unknown {
  if (value === undefined) {
    return '[Undefined]';
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value === 'function') {
    return value.name ? `[Function ${value.name}]` : '[Function]';
  }
  if (typeof value === 'symbol') {
    return String(value);
  }
  if (typeof value === 'number') {
    return normalizeDiagnosticNumber(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (active.has(value)) {
    return CIRCULAR_REFERENCE_MARKER;
  }

  active.add(value);
  try {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : '[Invalid Date]';
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeDiagnosticValue(entry, active));
    }
    if (value instanceof Error) {
      const customEntries = Object.entries(value).filter(
        ([key]) => !['cause', 'message', 'name', 'stack'].includes(key)
      );
      return {
        ...Object.fromEntries(
          customEntries.map(([key, entry]) => [key, normalizeDiagnosticValue(entry, active)])
        ),
        cause: normalizeDiagnosticValue(value.cause, active),
        message: value.message,
        name: value.name,
        stack: value.stack ?? '[Undefined]',
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeDiagnosticValue(entry, active)])
    );
  } finally {
    active.delete(value);
  }
}

export function serializeDiagnosticJson(
  value: unknown,
  description: string,
  space?: number
): string {
  const json = JSON.stringify(normalizeDiagnosticValue(value, new WeakSet<object>()), null, space);
  if (json === undefined) {
    throw new Error(`${description} could not be serialized as JSON`);
  }
  return json;
}

export function serializeLogContextJson(context: Record<string, unknown> | null): string {
  return serializeDiagnosticJson(context ?? {}, 'Log context', 2);
}

export function serializeLogRecordJson(record: LogRecord): string {
  return serializeDiagnosticJson(record, 'Log record', 2);
}
