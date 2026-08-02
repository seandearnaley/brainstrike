import type {
  DiagnosticCauseEntry,
  DiagnosticEvent,
  DiagnosticSeverity,
} from './diagnostic-events.js';

/**
 * Fixed key order for the NDJSON wire format. Declared explicitly (rather
 * than derived from object literal insertion order) so that:
 *  - `pnpm dlx ultracite fix` re-sorting object keys elsewhere in the source
 *    can never silently reorder the wire format, and
 *  - the order is self-documenting and shared by every writer, independent of
 *    how a given `DiagnosticEvent` value happened to be constructed.
 * This is the contract that makes a `grep` hit in the desktop error-log file
 * and a row from the web NDJSON export (Task 6) the same object byte-for-byte.
 */
const NDJSON_KEY_ORDER = [
  'appVersion',
  'causeChain',
  'code',
  'context',
  'fingerprint',
  'id',
  'message',
  'occurredAt',
  'platform',
  'resourceId',
  'rootId',
  'runId',
  'scope',
  'sessionId',
  'severity',
  'source',
  'stack',
  'threadId',
] as const satisfies readonly (keyof DiagnosticEvent)[];

// `satisfies readonly (keyof DiagnosticEvent)[]` above only checks that every
// LISTED key is a valid `DiagnosticEvent` key — it does NOT check the
// reverse. A newly added `DiagnosticEvent` field (optional or not) that
// nobody remembers to add to `NDJSON_KEY_ORDER` would compile fine and then
// silently vanish from every NDJSON line, breaking the "grep hit in the file
// == SQL row" contract this module exists to guarantee. This assertion turns
// that omission into a compile error instead: if it fails to compile, a
// `DiagnosticEvent` field is missing from `NDJSON_KEY_ORDER` above. Mirrors
// the same pattern in `packages/types/src/assistant-provider-settings.ts`
// (`assertNoMissingAssistantProviderSettingKeys`).
const assertNoMissingNdjsonKeys = <_MissingKeys extends never>(): void => undefined;
assertNoMissingNdjsonKeys<Exclude<keyof DiagnosticEvent, (typeof NDJSON_KEY_ORDER)[number]>>();

const VALID_SEVERITIES: readonly DiagnosticSeverity[] = ['warn', 'error', 'fatal'];

const REQUIRED_STRING_FIELDS = [
  'appVersion',
  'fingerprint',
  'id',
  'message',
  'platform',
  'sessionId',
  'source',
] as const satisfies readonly (keyof DiagnosticEvent)[];

const NULLABLE_STRING_FIELDS = [
  'code',
  'resourceId',
  'rootId',
  'runId',
  'scope',
  'stack',
  'threadId',
] as const satisfies readonly (keyof DiagnosticEvent)[];

/**
 * Serializes a single `DiagnosticEvent` to one NDJSON line: no trailing
 * newline, and no raw newlines embedded in the line (`JSON.stringify` escapes
 * `\n` inside string values as `\\n`).
 */
export function serializeDiagnosticEventLine(event: DiagnosticEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of NDJSON_KEY_ORDER) {
    ordered[key] = event[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Joins multiple events into an NDJSON blob: one line per event, `\n`
 * separated, with exactly one trailing `\n`. Used by the web NDJSON export
 * (Task 6). An empty input yields an empty string rather than a lone blank
 * line.
 */
export function serializeDiagnosticEventsNdjson(events: readonly DiagnosticEvent[]): string {
  if (events.length === 0) {
    return '';
  }
  return `${events.map(serializeDiagnosticEventLine).join('\n')}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isValidSeverity(value: unknown): value is DiagnosticSeverity {
  return typeof value === 'string' && (VALID_SEVERITIES as readonly string[]).includes(value);
}

export function isDiagnosticCauseEntry(value: unknown): value is DiagnosticCauseEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['message'] !== 'string' || typeof value['name'] !== 'string') {
    return false;
  }
  return value['code'] === undefined || typeof value['code'] === 'string';
}

function isCauseChain(value: unknown): value is readonly DiagnosticCauseEntry[] | null {
  if (value === null) {
    return true;
  }
  return Array.isArray(value) && value.every(isDiagnosticCauseEntry);
}

function isContext(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

function hasValidRequiredFields(record: Record<string, unknown>): boolean {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string') {
      return false;
    }
  }
  return typeof record['occurredAt'] === 'number' && isValidSeverity(record['severity']);
}

function hasValidOptionalFields(record: Record<string, unknown>): boolean {
  for (const field of NULLABLE_STRING_FIELDS) {
    if (!isNullableString(record[field])) {
      return false;
    }
  }
  return isCauseChain(record['causeChain']) && isContext(record['context']);
}

/**
 * Parses one NDJSON line back into a `DiagnosticEvent`.
 *
 * Returns `null` for a blank line or a line that is malformed JSON or does
 * not carry the required fields / a valid severity. This is a DELIBERATE,
 * documented contract — not a swallowed error: a process crash can truncate
 * the last line written to the desktop error-log file mid-write, and readers
 * (tail viewers, importers) must be able to skip that partial trailing line
 * without the whole read throwing. Callers that need to distinguish "end of
 * file" from "corrupt line" should count/log the `null` results themselves;
 * this function never coerces a bad shape into a partial or default event.
 */
export function parseDiagnosticEventLine(line: string): DiagnosticEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (!(hasValidRequiredFields(parsed) && hasValidOptionalFields(parsed))) {
    return null;
  }

  const event: Record<string, unknown> = {};
  for (const key of NDJSON_KEY_ORDER) {
    event[key] = parsed[key] ?? null;
  }
  return event as unknown as DiagnosticEvent;
}
