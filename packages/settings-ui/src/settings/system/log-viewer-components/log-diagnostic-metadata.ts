import type { LogRecord } from '@brainstrike/logging';
import { type DiagnosticCauseEntry, isDiagnosticCauseEntry } from '@brainstrike/utils/diagnostics';

const CIRCULAR_REFERENCE_MARKER = '[Circular]';
const DIAGNOSTIC_SERIALIZATION_FAILURE_MARKER = '[Diagnostic serialization failed]';
const BINDINGS_SERIALIZATION_FAILURE_MARKER = '[Bindings serialization failed]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBindingValue(record: LogRecord, key: string): unknown {
  try {
    return record.bindings?.[key];
  } catch {
    return;
  }
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
  return readNonEmptyString(readBindingValue(record, 'runtime')) ?? 'unknown';
}

export function getLogRecordCode(record: LogRecord): string | null {
  return (
    readNonEmptyString(readBindingValue(record, 'code')) ??
    readNonEmptyString(getLogRecordContext(record)?.['code'])
  );
}

export function getLogRecordFingerprint(record: LogRecord): string | null {
  return readNonEmptyString(readBindingValue(record, 'fingerprint'));
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

function normalizeBindingsValue(value: unknown, active: WeakSet<object>): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? BINDINGS_SERIALIZATION_FAILURE_MARKER
      : JSON.parse(serialized);
  } catch {
    const normalized = normalizeDiagnosticValue(
      value,
      active,
      BINDINGS_SERIALIZATION_FAILURE_MARKER
    );
    return typeof normalized === 'object' &&
      normalized !== null &&
      !Array.isArray(normalized) &&
      Object.keys(normalized).length === 0
      ? BINDINGS_SERIALIZATION_FAILURE_MARKER
      : normalized;
  }
}

function normalizeDiagnosticValue(
  value: unknown,
  active: WeakSet<object>,
  failureMarker = DIAGNOSTIC_SERIALIZATION_FAILURE_MARKER
): unknown {
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
    try {
      if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString() : '[Invalid Date]';
      }
      if (Array.isArray(value)) {
        return value.map((entry) => {
          try {
            return normalizeDiagnosticValue(entry, active, failureMarker);
          } catch {
            return failureMarker;
          }
        });
      }
      if (value instanceof Error) {
        const customEntries = Object.entries(value).filter(
          ([key]) => !['cause', 'message', 'name', 'stack'].includes(key)
        );
        return {
          ...Object.fromEntries(
            customEntries.map(([key, entry]) => [
              key,
              normalizeDiagnosticValue(entry, active, failureMarker),
            ])
          ),
          cause: normalizeDiagnosticValue(value.cause, active, failureMarker),
          message: value.message,
          name: value.name,
          stack: value.stack ?? '[Undefined]',
        };
      }
      let keys: string[];
      try {
        keys = Object.keys(value);
      } catch {
        return failureMarker;
      }
      return Object.fromEntries(
        keys.map((key) => {
          const childFailureMarker =
            key === 'bindings' ? BINDINGS_SERIALIZATION_FAILURE_MARKER : failureMarker;
          try {
            const childValue = Reflect.get(value, key);
            return [
              key,
              key === 'bindings'
                ? normalizeBindingsValue(childValue, active)
                : normalizeDiagnosticValue(childValue, active, childFailureMarker),
            ];
          } catch {
            return [key, childFailureMarker];
          }
        })
      );
    } catch {
      return failureMarker;
    }
  } finally {
    active.delete(value);
  }
}

export function serializeDiagnosticJson(
  value: unknown,
  description: string,
  space?: number,
  failureMarker = DIAGNOSTIC_SERIALIZATION_FAILURE_MARKER
): string {
  const json = JSON.stringify(
    normalizeDiagnosticValue(value, new WeakSet<object>(), failureMarker),
    null,
    space
  );
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
