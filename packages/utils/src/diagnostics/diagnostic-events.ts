import { LogLevel, type LogRecord, redactSensitiveLogValue } from '../logger';

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

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function walkCauseChain(error: Error): DiagnosticCauseEntry[] {
  const chain: DiagnosticCauseEntry[] = [];
  let current: unknown = error.cause;
  while (current instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    const code =
      isRecord(current) && typeof current['code'] === 'string' ? current['code'] : undefined;
    chain.push({
      ...(code && { code }),
      message: boundWithMarker(current.message, 500),
      name: current.name,
    });
    current = current.cause;
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
    if (arg instanceof Error) {
      stack ??= arg.stack ? boundWithMarker(arg.stack, DIAGNOSTIC_STACK_MAX_CHARS) : null;
      const chain = walkCauseChain(arg);
      causeChain ??= chain.length > 0 ? chain : null;
      context['errorName'] = arg.name;
      context['errorMessage'] = boundWithMarker(arg.message, DIAGNOSTIC_MESSAGE_MAX_CHARS);
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
  const serialized = JSON.stringify(redacted);
  const boundedContext =
    serialized.length > DIAGNOSTIC_CONTEXT_MAX_CHARS
      ? { truncatedContext: boundWithMarker(serialized, DIAGNOSTIC_CONTEXT_MAX_CHARS) }
      : redacted;

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
