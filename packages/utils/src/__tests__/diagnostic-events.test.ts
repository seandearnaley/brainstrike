import { describe, expect, it } from 'vitest';
import {
  computeDiagnosticFingerprint,
  DIAGNOSTIC_MESSAGE_MAX_CHARS,
  deriveDiagnosticRecordSource,
  logRecordToDiagnosticEvent,
} from '../diagnostics/diagnostic-events.js';
import { addLogListener, LogLevel, type LogRecord, error as logError } from '../logger.js';

const ENV = {
  appVersion: '1.0.0-test',
  makeId: () => 'id-1',
  platform: 'test',
  sessionId: 'session-1',
  source: 'web-renderer',
};

describe('computeDiagnosticFingerprint', () => {
  it('is stable across uuids, digits, and paths in the message', () => {
    const a = computeDiagnosticFingerprint(
      null,
      'Scope',
      'run 123e4567-e89b-42d3-a456-426614174000 failed after 250ms at /Users/x/y.ts'
    );
    const b = computeDiagnosticFingerprint(
      null,
      'Scope',
      'run 99999999-aaaa-4bbb-8ccc-000000000001 failed after 9001ms at /home/z/q.ts'
    );
    expect(a).toBe(b);
  });

  it('differs when the code differs', () => {
    expect(computeDiagnosticFingerprint('a', 's', 'm')).not.toBe(
      computeDiagnosticFingerprint('b', 's', 'm')
    );
  });
});

describe('deriveDiagnosticRecordSource', () => {
  // Single shared implementation (FIX 5, error-observability P2a review): both
  // the desktop main-process durable NDJSON sink (error-log-sink.ts) and the
  // renderer DiagnosticSinkBridge's forwarded-record path previously carried
  // byte-identical copies of this logic — these cases pin the contract that
  // makes a grep hit in the NDJSON file and a DB row resolve to the same
  // `source`.
  it('resolves electron-main from bindings.runtime, regardless of sourceWindowRole', () => {
    expect(
      deriveDiagnosticRecordSource({
        args: [],
        bindings: { runtime: 'electron-main', sourceWindowRole: 'visible-ui' },
        level: LogLevel.ERROR,
        timestamp: 1,
      })
    ).toBe('electron-main');
  });

  it('resolves bindings.sourceWindowRole when runtime is not electron-main', () => {
    expect(
      deriveDiagnosticRecordSource({
        args: [],
        bindings: { sourceWindowRole: 'chunking-host' },
        level: LogLevel.ERROR,
        timestamp: 1,
      })
    ).toBe('chunking-host');
  });

  it('falls back to hidden-host when neither binding is present', () => {
    expect(
      deriveDiagnosticRecordSource({
        args: [],
        bindings: {},
        level: LogLevel.ERROR,
        timestamp: 1,
      })
    ).toBe('hidden-host');
  });
});

describe('logRecordToDiagnosticEvent', () => {
  it('returns null below the warn floor', () => {
    expect(
      logRecordToDiagnosticEvent(
        { args: ['hello'], bindings: {}, level: LogLevel.INFO, message: 'hello', timestamp: 1 },
        ENV
      )
    ).toBeNull();
  });

  it('maps a warn record with scope, code metadata, and correlation ids', () => {
    const event = logRecordToDiagnosticEvent(
      {
        args: ['boom', { code: 'stream_inactivity_timeout', runId: 'run-1', threadId: 'thread-1' }],
        bindings: { appName: 'brainstrike' },
        level: LogLevel.ERROR,
        message: 'boom',
        scope: 'AgentStream',
        timestamp: 1234,
      },
      ENV
    );
    expect(event).toMatchObject({
      code: 'stream_inactivity_timeout',
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      id: 'id-1',
      message: 'boom',
      occurredAt: 1234,
      runId: 'run-1',
      scope: 'AgentStream',
      sessionId: 'session-1',
      severity: 'error',
      source: 'web-renderer',
      threadId: 'thread-1',
    });
  });

  it('walks Error args into stack + cause chain and truncates visibly', () => {
    const cause = new Error('root cause');
    const err = new Error('x'.repeat(DIAGNOSTIC_MESSAGE_MAX_CHARS + 50), { cause });
    const event = logRecordToDiagnosticEvent(
      {
        args: ['failed', err],
        bindings: {},
        level: LogLevel.ERROR,
        message: 'failed',
        timestamp: 1,
      },
      ENV
    );
    expect(event?.stack).toContain('Error');
    expect(event?.causeChain?.[0]?.message).toBe('root cause');
    expect(event?.context?.['errorMessage']).toContain('…[truncated');
  });

  it('terminates cyclic Error cause chains with a visible marker', () => {
    const error = new Error('cyclic cause');
    error.cause = error;

    const event = logRecordToDiagnosticEvent(
      {
        args: ['failed', error],
        bindings: {},
        level: LogLevel.ERROR,
        message: 'failed',
        timestamp: 1,
      },
      ENV
    );

    expect(event?.causeChain).toEqual([
      { message: 'cyclic cause', name: 'Error' },
      { message: '[Circular]', name: '[Circular]' },
    ]);
  });

  it('preserves stack + cause chain for a REAL logger call through the redaction pipeline', () => {
    // Regression for the bug where `emitLogRecord` fans args out through
    // `redactSensitiveLogValue` BEFORE listeners: since `Error.cause` is
    // non-enumerable, the plain `{message, name, stack}` object the redactor
    // produced used to silently drop the cause chain, so this never went
    // through the `instanceof Error` branch in production. Goes through the
    // REAL `error(...)` + `addLogListener` path end to end, not a
    // hand-constructed LogRecord.
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      captured.push(record);
    });
    try {
      logError(new Error('outer', { cause: new Error('root cause') }));
    } finally {
      unsubscribe();
    }

    expect(captured).toHaveLength(1);
    const record = captured[0];
    expect(record).toBeDefined();
    if (!record) {
      throw new Error('expected a captured log record');
    }

    const event = logRecordToDiagnosticEvent(record, ENV);
    expect(event?.stack?.length ?? 0).toBeGreaterThan(0);
    expect(event?.causeChain?.[0]?.message).toBe('root cause');

    // The raw redacted error object must NOT be duplicated wholesale into
    // context (that was the earlier, wrong fallback behavior).
    expect(event?.context?.['stack']).toBeUndefined();
    expect(event?.context?.['cause']).toBeUndefined();
    expect(event?.context?.['message']).toBeUndefined();
    expect(event?.context?.['errorName']).toBe('Error');
    expect(event?.context?.['errorMessage']).toBe('outer');
  });

  it('redacts sensitive keys in context', () => {
    const event = logRecordToDiagnosticEvent(
      {
        args: ['m', { apiKey: 'sk-secret', ok: 1 }],
        bindings: {},
        level: LogLevel.WARN,
        message: 'm',
        timestamp: 1,
      },
      ENV
    );
    expect(JSON.stringify(event?.context)).not.toContain('sk-secret');
  });

  it('marks cyclic diagnostic context without dropping the event', () => {
    const metadata: Record<string, unknown> = { operation: 'provider-request' };
    metadata['self'] = metadata;

    const event = logRecordToDiagnosticEvent(
      {
        args: ['m', metadata],
        bindings: {},
        level: LogLevel.WARN,
        message: 'm',
        timestamp: 1,
      },
      ENV
    );

    expect(event?.context).toEqual({
      operation: 'provider-request',
      self: {
        operation: 'provider-request',
        self: '[Circular]',
      },
    });
  });

  it('preserves shared acyclic context identity', () => {
    const shared = { operation: 'provider-request' };
    const event = logRecordToDiagnosticEvent(
      {
        args: ['m', { left: shared, right: shared }],
        bindings: {},
        level: LogLevel.WARN,
        message: 'm',
        timestamp: 1,
      },
      ENV
    );

    expect(event?.context?.['left']).toBe(event?.context?.['right']);
  });
});
