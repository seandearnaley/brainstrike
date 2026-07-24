import type { DiagnosticEventsDatabase } from '@brainstrike/db';
import type { DiagnosticEvent, DiagnosticSeverity } from '@brainstrike/utils/diagnostics';
import { LogLevel } from '@brainstrike/utils/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  createDurableLogSource,
  DURABLE_LOG_SOURCE_MAX_ROWS,
  DURABLE_LOG_SOURCE_POLL_MS,
  diagnosticEventToLogRecord,
} from '../diagnostics/durable-log-source';

interface QueryCall {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

/** `db.query` is generic (`<T>(sql, params) => Promise<{ rows: T[] }>`), so a
 * plain generic function stubs it faithfully — a `vi.fn()` wrapper loses the
 * generic and fails `tsc` against `DiagnosticEventsDatabase['query']`. Calls
 * are tracked on the side instead of via mock-call inspection. */
function makeStubDb(respond: (call: QueryCall) => unknown[]): {
  calls: QueryCall[];
  db: DiagnosticEventsDatabase;
} {
  const calls: QueryCall[] = [];
  return {
    calls,
    db: {
      query: <T>(sql: string, params?: unknown[]) => {
        const call: QueryCall = { params, sql };
        calls.push(call);
        return Promise.resolve({ rows: respond(call) as T[] });
      },
    },
  };
}

function makeRejectingDb(error: Error): { calls: QueryCall[]; db: DiagnosticEventsDatabase } {
  const calls: QueryCall[] = [];
  return {
    calls,
    db: {
      query: <T>(sql: string, params?: unknown[]) => {
        calls.push({ params, sql });
        return Promise.reject<{ rows: T[] }>(error);
      },
    },
  };
}

/** Each call returns a promise that stays pending until its matching
 * `resolvers[n]` is invoked — lets a test resolve overlapping queries in an
 * arbitrary order to exercise the generation guard in `subscribe`. */
function makeDeferredStubDb(): {
  calls: QueryCall[];
  db: DiagnosticEventsDatabase;
  resolvers: ((rows: unknown[]) => void)[];
} {
  const calls: QueryCall[] = [];
  const resolvers: ((rows: unknown[]) => void)[] = [];
  return {
    calls,
    db: {
      query: <T>(sql: string, params?: unknown[]) =>
        new Promise<{ rows: T[] }>((resolve) => {
          calls.push({ params, sql });
          resolvers.push((rows: unknown[]) => resolve({ rows: rows as T[] }));
        }),
    },
    resolvers,
  };
}

function makeEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    appVersion: '1.2.3',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: 'fp-abc123',
    id: 'diag-1',
    message: 'Provider stream closed unexpectedly',
    occurredAt: Date.parse('2026-07-23T12:00:30.000Z'),
    platform: 'darwin',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: 'AssistantStream',
    sessionId: 'session-fixed-1',
    severity: 'error',
    source: 'web-renderer',
    stack: null,
    threadId: null,
    ...overrides,
  };
}

function makeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    app_version: 'v1',
    cause_chain: null,
    code: null,
    context: null,
    fingerprint: `fp-${id}`,
    id,
    message: `message ${id}`,
    occurred_at: '2026-07-23T12:00:00.000Z',
    platform: 'test',
    resource_id: null,
    root_id: null,
    run_id: null,
    scope: null,
    session_id: 'session',
    severity: 'error',
    source: 'test',
    stack: null,
    thread_id: null,
    ...overrides,
  };
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function makeManualInterval() {
  const scheduled: { fn: () => void; ms: number | undefined }[] = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  const setIntervalStub = ((fn: () => void, ms?: number) => {
    const id = nextId;
    nextId += 1;
    scheduled.push({ fn, ms });
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval;
  const clearIntervalStub = ((id: unknown) => {
    cleared.push(id);
  }) as typeof globalThis.clearInterval;
  return { cleared, clearIntervalStub, scheduled, setIntervalStub };
}

describe('diagnosticEventToLogRecord', () => {
  it.each<[DiagnosticSeverity, LogLevel]>([
    ['warn', LogLevel.WARN],
    ['error', LogLevel.ERROR],
    ['fatal', LogLevel.FATAL],
  ])('maps severity %s to LogLevel %s', (severity, level) => {
    const event = makeEvent({ severity });
    expect(diagnosticEventToLogRecord(event).level).toBe(level);
  });

  it('maps timestamp/scope/message directly', () => {
    const event = makeEvent({ message: 'boom', occurredAt: 12_345, scope: 'AssistantStream' });
    const record = diagnosticEventToLogRecord(event);
    expect(record.timestamp).toBe(12_345);
    expect(record.scope).toBe('AssistantStream');
    expect(record.message).toBe('boom');
  });

  it('maps a null scope to undefined', () => {
    const record = diagnosticEventToLogRecord(makeEvent({ scope: null }));
    expect(record.scope).toBeUndefined();
  });

  it('carries source/code/fingerprint/sessionId/appVersion/platform in bindings', () => {
    const event = makeEvent({
      appVersion: '9.9.9',
      code: 'ECONNRESET',
      fingerprint: 'fp-xyz',
      platform: 'linux',
      sessionId: 'session-xyz',
      source: 'electron-main',
    });
    const record = diagnosticEventToLogRecord(event);
    expect(record.bindings).toMatchObject({
      appVersion: '9.9.9',
      code: 'ECONNRESET',
      fingerprint: 'fp-xyz',
      platform: 'linux',
      runtime: 'electron-main',
      sessionId: 'session-xyz',
    });
  });

  it('omits null-valued code and correlation ids from bindings', () => {
    const record = diagnosticEventToLogRecord(
      makeEvent({ code: null, resourceId: null, rootId: null, runId: null, threadId: null })
    );
    expect(record.bindings).not.toHaveProperty('code');
    expect(record.bindings).not.toHaveProperty('runId');
    expect(record.bindings).not.toHaveProperty('threadId');
    expect(record.bindings).not.toHaveProperty('resourceId');
    expect(record.bindings).not.toHaveProperty('rootId');
  });

  it('includes non-null correlation ids in bindings', () => {
    const record = diagnosticEventToLogRecord(
      makeEvent({
        resourceId: 'resource-1',
        rootId: 'root-1',
        runId: 'run-1',
        threadId: 'thread-1',
      })
    );
    expect(record.bindings).toMatchObject({
      resourceId: 'resource-1',
      rootId: 'root-1',
      runId: 'run-1',
      threadId: 'thread-1',
    });
  });

  it('carries stack and causeChain in a single trailing args object, alongside context and logSource', () => {
    const event = makeEvent({
      causeChain: [{ message: 'socket reset', name: 'Error' }],
      context: { attempt: 2 },
      source: 'web-renderer',
      stack: 'Error: boom\n    at fixture.ts:1:1',
    });
    const record = diagnosticEventToLogRecord(event);
    expect(record.args).toEqual([
      {
        attempt: 2,
        causeChain: event.causeChain,
        logSource: 'web-renderer',
        stack: event.stack,
      },
    ]);
  });

  it('omits stack/causeChain keys when absent, keeping only logSource', () => {
    const record = diagnosticEventToLogRecord(
      makeEvent({ causeChain: null, context: null, stack: null })
    );
    expect(record.args).toEqual([{ logSource: 'web-renderer' }]);
  });
});

describe('createDurableLogSource', () => {
  it('getInitialRecords issues one query and returns records ascending by timestamp', async () => {
    const rows = [
      makeRow('evt-3', { occurred_at: '2026-07-23T12:00:03.000Z' }),
      makeRow('evt-2', { occurred_at: '2026-07-23T12:00:02.000Z' }),
      makeRow('evt-1', { occurred_at: '2026-07-23T12:00:01.000Z' }),
    ];
    const { calls, db } = makeStubDb(() => rows);
    const source = createDurableLogSource({ db });

    const records = await source.getInitialRecords?.();

    expect(calls).toHaveLength(1);
    expect(records?.map((record) => record.timestamp)).toEqual([
      Date.parse('2026-07-23T12:00:01.000Z'),
      Date.parse('2026-07-23T12:00:02.000Z'),
      Date.parse('2026-07-23T12:00:03.000Z'),
    ]);
  });

  it('binds the limit exactly once and filters severity IN (warn, error, fatal)', async () => {
    const { calls, db } = makeStubDb(() => []);
    const source = createDurableLogSource({ db, limit: 500 });

    await source.getInitialRecords?.();

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain('brainstrike_diagnostic_events');
    expect(sql).toMatch(/severity IN \('warn', ?'error', ?'fatal'\)/);
    expect(sql.match(/\$1/g)).toHaveLength(1);
    expect(sql.match(/\$\d/g)).toHaveLength(1);
    expect(calls[0]?.params).toEqual([500]);
  });

  it('defaults the limit to DURABLE_LOG_SOURCE_MAX_ROWS', async () => {
    const { calls, db } = makeStubDb(() => []);
    const source = createDurableLogSource({ db });

    await source.getInitialRecords?.();

    expect(calls[0]?.params).toEqual([DURABLE_LOG_SOURCE_MAX_ROWS]);
  });

  it('yields a single synthetic WARN record instead of throwing when the query rejects', async () => {
    const { db } = makeRejectingDb(new Error('connection refused'));
    const source = createDurableLogSource({ db });

    const records = await source.getInitialRecords?.();

    expect(records).toHaveLength(1);
    expect(records?.[0]?.level).toBe(LogLevel.WARN);
    expect(records?.[0]?.scope).toBe('DurableLogSource');
    expect(records?.[0]?.message).toContain('connection refused');
  });

  it('subscribe emits immediately, again after an injected interval tick, and stops after unsubscribe', async () => {
    let callCount = 0;
    const { db } = makeStubDb(() => {
      callCount += 1;
      return [makeRow(`evt-${callCount}`)];
    });
    const { cleared, scheduled, setIntervalStub, clearIntervalStub } = makeManualInterval();
    const handler = vi.fn();

    const source = createDurableLogSource({
      clearInterval: clearIntervalStub,
      db,
      setInterval: setIntervalStub,
    });
    const unsubscribe = source.subscribe?.(handler);
    expect(unsubscribe).toBeTypeOf('function');

    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(DURABLE_LOG_SOURCE_POLL_MS);

    // Simulate the poll interval firing.
    scheduled[0]?.fn();
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(2);

    unsubscribe?.();
    expect(cleared).toHaveLength(1);

    // A stray/late tick after unsubscribe must not reach the handler — this
    // proves the adapter guards internally rather than relying solely on
    // clearInterval (which a stub timer cannot itself enforce).
    scheduled[0]?.fn();
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('subscribe surfaces a query rejection to the handler as a synthetic WARN instead of throwing', async () => {
    const { db } = makeRejectingDb(new Error('boom'));
    const { setIntervalStub, clearIntervalStub } = makeManualInterval();
    const handler =
      vi.fn<(records: readonly ReturnType<typeof diagnosticEventToLogRecord>[]) => void>();

    const source = createDurableLogSource({
      clearInterval: clearIntervalStub,
      db,
      setInterval: setIntervalStub,
    });
    expect(() => source.subscribe?.(handler)).not.toThrow();

    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
    const [records] = handler.mock.calls[0] ?? [[]];
    expect(records[0]?.level).toBe(LogLevel.WARN);
    expect(records[0]?.scope).toBe('DurableLogSource');
  });

  it('drops a stale poll result when a newer overlapping poll resolves first', async () => {
    const { db, resolvers } = makeDeferredStubDb();
    const { scheduled, setIntervalStub, clearIntervalStub } = makeManualInterval();
    const handler =
      vi.fn<(records: readonly ReturnType<typeof diagnosticEventToLogRecord>[]) => void>();

    const source = createDurableLogSource({
      clearInterval: clearIntervalStub,
      db,
      setInterval: setIntervalStub,
    });
    source.subscribe?.(handler);

    // The immediate emit() on subscribe() issues request #1 — still pending.
    expect(resolvers).toHaveLength(1);

    // A second, overlapping tick fires before #1 resolves — issues request #2.
    scheduled[0]?.fn();
    expect(resolvers).toHaveLength(2);

    // Resolve the NEWER request (#2) first, with fresh rows.
    resolvers[1]?.([makeRow('newer')]);
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.[0]?.bindings['fingerprint']).toBe('fp-newer');

    // Resolve the STALE request (#1) after — it must never reach the handler,
    // and must not clobber the already-delivered newer snapshot.
    resolvers[0]?.([makeRow('older')]);
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.[0]?.bindings['fingerprint']).toBe('fp-newer');
  });

  it('returns one adapter object with stable getInitialRecords/subscribe references across accesses', () => {
    const { db } = makeStubDb(() => []);

    const source = createDurableLogSource({ db });
    const { getInitialRecords, subscribe } = source;

    expect(source.getInitialRecords).toBe(getInitialRecords);
    expect(source.subscribe).toBe(subscribe);
    expect(source.getInitialRecords).toBe(source.getInitialRecords);
    expect(source.subscribe).toBe(source.subscribe);
  });
});
