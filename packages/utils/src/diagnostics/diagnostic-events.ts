import { LogLevel, type LogRecord, redactSensitiveLogValue } from '@brainstrike/logging';

export type DiagnosticSeverity = 'warn' | 'error' | 'fatal';

export interface DiagnosticCauseEntry {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

export interface DiagnosticEvent {
  readonly appVersion: string;
  readonly causeChain: readonly DiagnosticCauseEntry[] | null;
  readonly code: string | null;
  readonly context: Record<string, unknown> | null;
  readonly fingerprint: string;
  readonly id: string;
  readonly message: string;
  readonly occurredAt: number;
  readonly platform: string;
  readonly resourceId: string | null;
  readonly rootId: string | null;
  readonly runId: string | null;
  readonly scope: string | null;
  readonly sessionId: string;
  readonly severity: DiagnosticSeverity;
  readonly source: string;
  readonly stack: string | null;
  readonly threadId: string | null;
}

export const DIAGNOSTIC_MESSAGE_MAX_CHARS = 2000;
export const DIAGNOSTIC_STACK_MAX_CHARS = 8000;
export const DIAGNOSTIC_CONTEXT_MAX_CHARS = 8000;
const MAX_CAUSE_DEPTH = 5;

const SEVERITY_BY_LEVEL: Partial<Record<LogLevel, DiagnosticSeverity>> = {
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.FATAL]: 'fatal',
};

/** Visible-truncation helper: elision must never be silent (design §4.2). */
export function boundWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `…[truncated ${value.length - maxChars} chars]`;
  return value.slice(0, maxChars) + suffix;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g;
const DIGIT_RE = /\d+/g;
const CIRCULAR_REFERENCE_MARKER = '[Circular]';

/** FNV-1a 64-bit over the normalized identity (sync, dependency-free — md5 in
 * the design doc was illustrative; the property that matters is stability). */
export function computeDiagnosticFingerprint(
  code: string | null,
  scope: string | null,
  message: string
): string {
  const normalized = message
    .replace(UUID_RE, '<uuid>')
    .replace(PATH_RE, '<path>')
    .replace(HEX_RE, '<hex>')
    .replace(DIGIT_RE, '<n>');
  const identity = `${code ?? ''}|${scope ?? ''}|${normalized}`;
  let hash = 0xcb_f2_9c_e4_84_22_23_25n;
  const prime = 0x1_00_00_00_01_b3n;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= BigInt(identity.charCodeAt(index));
    hash = (hash * prime) & 0xff_ff_ff_ff_ff_ff_ff_ffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function markCircularReferences(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR_REFERENCE_MARKER;
  }

  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => markCircularReferences(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, markCircularReferences(entry, ancestors)])
      );
  ancestors.delete(value);
  return result;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

type ErrorShapedRecord = Record<string, unknown> & { message: string; name: string };

/** After `redactSensitiveLogValue` runs (see logger.ts), a real `Error` arrives
 * here as a plain object `{message, name, stack, cause?}` — `Object.assign`
 * copies those three as enumerable own props, and `cause` (when present) is
 * copied through recursively by the redactor too. Recognize that shape so the
 * cause chain and stack survive redaction instead of being merged wholesale
 * into `context`. */
function isErrorShapedRecord(value: unknown): value is ErrorShapedRecord {
  if (!isRecord(value)) {
    return false;
  }
  const name = value['name'];
  const message = value['message'];
  if (typeof name !== 'string' || typeof message !== 'string') {
    return false;
  }
  return typeof value['stack'] === 'string' || 'cause' in value;
}

function causeEntryFrom(current: Error | ErrorShapedRecord): DiagnosticCauseEntry {
  const code =
    isRecord(current) && typeof current['code'] === 'string' ? current['code'] : undefined;
  return {
    ...(code && { code }),
    message: boundWithMarker(current.message, 500),
    name: current.name,
  };
}

/** Walks a `.cause` chain starting from `cause`, accepting either real `Error`
 * instances (direct callers) or redaction-flattened error-shaped plain
 * records (real logger callers — see `isErrorShapedRecord` above). Chains can
 * legitimately mix both shapes since redaction is applied top-down. */
function walkCauseChain(cause: unknown): DiagnosticCauseEntry[] {
  const chain: DiagnosticCauseEntry[] = [];
  const visited = new WeakSet<object>();
  let current: unknown = cause;
  while (chain.length < MAX_CAUSE_DEPTH) {
    if (!(current instanceof Error || isErrorShapedRecord(current))) {
      break;
    }
    if (visited.has(current)) {
      chain.push({
        message: CIRCULAR_REFERENCE_MARKER,
        name: CIRCULAR_REFERENCE_MARKER,
      });
      break;
    }

    visited.add(current);
    chain.push(causeEntryFrom(current));
    current = current instanceof Error ? current.cause : current['cause'];
  }
  return chain;
}

export interface DiagnosticEventEnv {
  readonly appVersion: string;
  readonly makeId: () => string;
  readonly platform: string;
  readonly sessionId: string;
  readonly source: string;
}

/**
 * Derives a `DiagnosticEvent.source` value from a `LogRecord`'s bindings.
 * The SINGLE shared implementation for both places that convert a raw
 * `LogRecord` into a `source` string: the Electron main-process durable
 * NDJSON sink (`apps/desktop/src/diagnostics/error-log-sink.ts`) and the
 * renderer `DiagnosticSinkBridge`'s main→renderer forwarded-record path
 * (`packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`). Both
 * previously carried a byte-identical copy of this function with only a
 * comment asserting they mirror each other — moved here so there is exactly
 * one implementation to diverge from, preserving the P2a "a grep hit in the
 * NDJSON file and a DB row are the same object" contract.
 */
export function deriveDiagnosticRecordSource(record: LogRecord): string {
  if (record.bindings['runtime'] === 'electron-main') {
    return 'electron-main';
  }
  return String(record.bindings['sourceWindowRole'] ?? 'hidden-host');
}

interface ErrorArgFields {
  readonly cause: unknown;
  readonly message: string;
  readonly name: string;
  readonly stack: string | null;
}

interface AppliedErrorArg {
  readonly causeChain: DiagnosticCauseEntry[];
  readonly stack: string | null;
}

/** Shared by both the `instanceof Error` and `isErrorShapedRecord` branches
 * below: populates `context.errorName`/`errorMessage` (never the wholesale
 * object) and walks the cause chain, given whichever shape the arg was. */
function applyErrorArg(context: Record<string, unknown>, fields: ErrorArgFields): AppliedErrorArg {
  context['errorName'] = fields.name;
  context['errorMessage'] = boundWithMarker(fields.message, DIAGNOSTIC_MESSAGE_MAX_CHARS);
  return {
    causeChain: walkCauseChain(fields.cause),
    stack: fields.stack ? boundWithMarker(fields.stack, DIAGNOSTIC_STACK_MAX_CHARS) : null,
  };
}

function errorArgFieldsFrom(arg: Error | ErrorShapedRecord): ErrorArgFields {
  if (arg instanceof Error) {
    return { cause: arg.cause, message: arg.message, name: arg.name, stack: arg.stack ?? null };
  }
  const stackValue = arg['stack'];
  return {
    cause: arg['cause'],
    message: arg['message'],
    name: arg['name'],
    stack: typeof stackValue === 'string' ? stackValue : null,
  };
}

export function logRecordToDiagnosticEvent(
  record: LogRecord,
  env: DiagnosticEventEnv
): DiagnosticEvent | null {
  const severity = SEVERITY_BY_LEVEL[record.level];
  if (!severity) {
    return null;
  }

  let stack: string | null = null;
  let causeChain: readonly DiagnosticCauseEntry[] | null = null;
  const context: Record<string, unknown> = {};

  for (const arg of record.args) {
    if (arg instanceof Error || isErrorShapedRecord(arg)) {
      // Redaction-flattened Errors (see isErrorShapedRecord) arrive as plain
      // records — do NOT fall through to the wholesale
      // `Object.assign(context, arg)` below: that would duplicate
      // message/name/stack/cause into context verbatim.
      const applied = applyErrorArg(context, errorArgFieldsFrom(arg));
      stack ??= applied.stack;
      causeChain ??= applied.causeChain.length > 0 ? applied.causeChain : null;
    } else if (isRecord(arg)) {
      Object.assign(context, arg);
    }
  }

  const code = readString(context, 'code');
  const message = boundWithMarker(
    record.message ?? (typeof record.args[0] === 'string' ? record.args[0] : ''),
    DIAGNOSTIC_MESSAGE_MAX_CHARS
  );

  const redacted = redactSensitiveLogValue(context) as Record<string, unknown>;
  let jsonSafeContext = redacted;
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    // Cyclic graphs are valid logger metadata, so replace their back-edges
    // visibly. Unsupported non-cyclic JSON values still throw on this second
    // serialization attempt instead of degrading silently.
    jsonSafeContext = markCircularReferences(redacted) as Record<string, unknown>;
    serialized = JSON.stringify(jsonSafeContext);
  }
  const boundedContext =
    serialized.length > DIAGNOSTIC_CONTEXT_MAX_CHARS
      ? { truncatedContext: boundWithMarker(serialized, DIAGNOSTIC_CONTEXT_MAX_CHARS) }
      : jsonSafeContext;

  return {
    appVersion: env.appVersion,
    causeChain,
    code,
    context: Object.keys(boundedContext).length > 0 ? boundedContext : null,
    fingerprint: computeDiagnosticFingerprint(code, record.scope ?? null, message),
    id: env.makeId(),
    message,
    occurredAt: record.timestamp,
    platform: env.platform,
    resourceId: readString(context, 'resourceId'),
    rootId: readString(context, 'rootId'),
    runId: readString(context, 'runId'),
    scope: record.scope ?? null,
    sessionId: env.sessionId,
    severity,
    source: env.source,
    stack,
    threadId: readString(context, 'threadId'),
  };
}
