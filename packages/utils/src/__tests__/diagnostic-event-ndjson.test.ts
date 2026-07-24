import { describe, expect, it } from 'vitest';
import {
  parseDiagnosticEventLine,
  serializeDiagnosticEventLine,
  serializeDiagnosticEventsNdjson,
} from '../diagnostics/diagnostic-event-ndjson';
import type { DiagnosticEvent } from '../diagnostics/diagnostic-events';

const FULL_EVENT: DiagnosticEvent = {
  appVersion: '1.0.0',
  causeChain: [{ code: 'ECAUSE', message: 'root cause', name: 'Error' }],
  code: 'E_TEST',
  context: { foo: 'bar', nested: { a: 1 } },
  fingerprint: 'abc123',
  id: 'evt-1',
  message: 'boom',
  occurredAt: 1_700_000_000_000,
  platform: 'desktop',
  resourceId: 'res-1',
  rootId: 'root-1',
  runId: 'run-1',
  scope: 'TestScope',
  sessionId: 'session-1',
  severity: 'error',
  source: 'web-renderer',
  stack: 'Error: boom\n    at foo (bar.ts:1:1)',
  threadId: 'thread-1',
};

const MINIMAL_EVENT: DiagnosticEvent = {
  appVersion: '1.0.0',
  causeChain: null,
  code: null,
  context: null,
  fingerprint: 'def456',
  id: 'evt-2',
  message: 'quiet warning',
  occurredAt: 1_700_000_001_000,
  platform: 'web',
  resourceId: null,
  rootId: null,
  runId: null,
  scope: null,
  sessionId: 'session-2',
  severity: 'warn',
  source: 'main',
  stack: null,
  threadId: null,
};

// The exact key order the design promises callers: it mirrors the
// DiagnosticEvent field list (alphabetical) so a grep hit in the desktop
// error-log file and a row in the web NDJSON export read the same way.
const EXPECTED_KEY_ORDER = [
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
];

describe('serializeDiagnosticEventLine / parseDiagnosticEventLine', () => {
  it('round-trips a fully populated event (causeChain + context present)', () => {
    const line = serializeDiagnosticEventLine(FULL_EVENT);
    expect(parseDiagnosticEventLine(line)).toEqual(FULL_EVENT);
  });

  it('round-trips a minimal event with null causeChain/context and other nullable fields', () => {
    const line = serializeDiagnosticEventLine(MINIMAL_EVENT);
    expect(parseDiagnosticEventLine(line)).toEqual(MINIMAL_EVENT);
  });

  it('produces a single line with no raw newlines when message/stack contain newlines', () => {
    const event: DiagnosticEvent = {
      ...FULL_EVENT,
      message: 'line one\nline two',
      stack: 'Error: line one\n    at frame\n    at another frame',
    };
    const line = serializeDiagnosticEventLine(event);
    expect(line.includes('\n')).toBe(false);
    expect(parseDiagnosticEventLine(line)).toEqual(event);
  });

  it('emits keys in a fixed order regardless of the input object property order', () => {
    // Same values as FULL_EVENT, but the object literal declares keys in the
    // reverse order — this must not affect the serialized key order.
    const reordered: DiagnosticEvent = {
      appVersion: FULL_EVENT.appVersion,
      causeChain: FULL_EVENT.causeChain,
      code: FULL_EVENT.code,
      context: FULL_EVENT.context,
      fingerprint: FULL_EVENT.fingerprint,
      id: FULL_EVENT.id,
      message: FULL_EVENT.message,
      occurredAt: FULL_EVENT.occurredAt,
      platform: FULL_EVENT.platform,
      resourceId: FULL_EVENT.resourceId,
      rootId: FULL_EVENT.rootId,
      runId: FULL_EVENT.runId,
      scope: FULL_EVENT.scope,
      sessionId: FULL_EVENT.sessionId,
      severity: FULL_EVENT.severity,
      source: FULL_EVENT.source,
      stack: FULL_EVENT.stack,
      threadId: FULL_EVENT.threadId,
    };

    const lineFromFull = serializeDiagnosticEventLine(FULL_EVENT);
    const lineFromReordered = serializeDiagnosticEventLine(reordered);

    expect(lineFromReordered).toBe(lineFromFull);
    expect(Object.keys(JSON.parse(lineFromFull))).toEqual(EXPECTED_KEY_ORDER);
  });

  it('returns null for a blank line', () => {
    expect(parseDiagnosticEventLine('')).toBeNull();
  });

  it('returns null for a whitespace-only line', () => {
    expect(parseDiagnosticEventLine('   ')).toBeNull();
  });

  it('returns null for malformed JSON, e.g. a crash-truncated tail line', () => {
    expect(parseDiagnosticEventLine('{bad json')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseDiagnosticEventLine('{"id":"x"}')).toBeNull();
  });

  it('returns null for an invalid severity value', () => {
    const invalid = { ...FULL_EVENT, severity: 'info' };
    expect(parseDiagnosticEventLine(JSON.stringify(invalid))).toBeNull();
  });

  it('returns null when occurredAt is not a number', () => {
    const invalid = { ...FULL_EVENT, occurredAt: '1700000000000' };
    expect(parseDiagnosticEventLine(JSON.stringify(invalid))).toBeNull();
  });

  it('returns null when causeChain is present but not an array', () => {
    const invalid = { ...FULL_EVENT, causeChain: 'not-an-array' };
    expect(parseDiagnosticEventLine(JSON.stringify(invalid))).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(parseDiagnosticEventLine('[1,2,3]')).toBeNull();
  });
});

describe('serializeDiagnosticEventsNdjson', () => {
  it('joins events with newlines and ends with exactly one trailing newline', () => {
    const ndjson = serializeDiagnosticEventsNdjson([FULL_EVENT, MINIMAL_EVENT]);

    expect(ndjson.endsWith('\n')).toBe(true);
    expect(ndjson.endsWith('\n\n')).toBe(false);

    const lines = ndjson.split('\n');
    expect(lines).toHaveLength(3); // 2 event lines + empty string after trailing \n
    expect(lines[2]).toBe('');
    expect(parseDiagnosticEventLine(lines[0] ?? '')).toEqual(FULL_EVENT);
    expect(parseDiagnosticEventLine(lines[1] ?? '')).toEqual(MINIMAL_EVENT);
  });

  it('returns an empty string for zero events (no spurious blank line)', () => {
    expect(serializeDiagnosticEventsNdjson([])).toBe('');
  });
});
