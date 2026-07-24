import { describe, expect, it } from 'vitest';
import {
  computeDiagnosticFingerprint,
  DIAGNOSTIC_MESSAGE_MAX_CHARS,
  logRecordToDiagnosticEvent,
} from '../diagnostics/diagnostic-events';
import { LogLevel } from '../logger';

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
});
