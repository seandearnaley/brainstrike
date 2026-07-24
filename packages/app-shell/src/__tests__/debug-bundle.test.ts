import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { describe, expect, it } from 'vitest';
import {
  buildThreadDebugBundle,
  collectThreadDebugBundleData,
  DEBUG_BUNDLE_DEFAULT_MAX_BYTES,
  DEBUG_BUNDLE_FORMAT_VERSION,
  type DebugBundleDatabase,
  formatThreadDebugBundle,
  type ThreadDebugBundleData,
} from '../diagnostics/debug-bundle';

function makeGoldenFixture(): ThreadDebugBundleData {
  const diagnosticEvent: DiagnosticEvent = {
    appVersion: '1.2.3',
    causeChain: [{ code: 'ECONNRESET', message: 'socket reset', name: 'Error' }],
    code: 'provider_stream_error',
    context: { attempt: 2 },
    fingerprint: 'fp-abc123',
    id: 'diag-1',
    message: 'Provider stream closed unexpectedly',
    occurredAt: Date.parse('2026-07-23T12:00:30.000Z'),
    platform: 'darwin',
    resourceId: 'resource-1',
    rootId: 'root-1',
    runId: 'run-1',
    scope: 'AssistantStream',
    sessionId: 'session-fixed-1',
    severity: 'error',
    source: 'web-renderer',
    stack: 'Error: socket reset\n    at fixture.ts:1:1',
    threadId: 'thread-1',
  };

  return {
    diagnosticEvents: [diagnosticEvent],
    environment: {
      appVersion: '1.2.3',
      generatedAt: '2026-07-23T12:05:00.000Z',
      platform: 'darwin',
      sessionId: 'session-fixed-1',
    },
    messages: [
      {
        content: [{ text: 'Please fix the bug in checkout.ts', type: 'text' }],
        createdAt: '2026-07-23T12:00:00.000Z',
        id: 'msg-1',
        role: 'user',
      },
      {
        content: [
          {
            args: { path: 'checkout.ts' },
            result: 'export function checkout() { /* ... */ }',
            toolName: 'read_file',
            type: 'tool-result',
          },
        ],
        createdAt: '2026-07-23T12:00:10.000Z',
        id: 'msg-2',
        role: 'assistant',
      },
      {
        content: [{ text: 'The stream failed before I could finish.', type: 'text' }],
        createdAt: '2026-07-23T12:00:20.000Z',
        id: 'msg-3',
        role: 'assistant',
      },
    ],
    priorFailures: {
      count: 4,
      firstSeenMs: Date.parse('2026-07-16T09:00:00.000Z'),
      lastSeenMs: Date.parse('2026-07-23T12:00:30.000Z'),
    },
    run: {
      completedAt: '2026-07-23T12:00:31.000Z',
      error: 'Provider stream closed unexpectedly',
      id: 'run-1',
      model: 'claude-sonnet-5',
      modelSettings: { apiKey: 'sk-live-123', temperature: 0.2 },
      provider: 'anthropic',
      providerOptions: { anthropicBeta: ['prompt-caching-2024-07-31'] },
      runtimeKind: 'agent',
      startedAt: '2026-07-23T12:00:00.000Z',
      status: 'failed',
    },
    runEvents: [
      {
        detail: 'Resolved 3 native tools',
        durationMs: 12,
        kind: 'tool.registered',
        label: 'Native tools',
        metadata: { toolNames: ['read_file', 'write_file', 'grep'] },
        occurredAt: '2026-07-23T12:00:00.500Z',
        sequence: 1,
        status: 'ok',
      },
      {
        detail: null,
        durationMs: null,
        kind: 'stream.error',
        label: 'Provider stream',
        metadata: null,
        occurredAt: '2026-07-23T12:00:30.000Z',
        sequence: 2,
        status: 'failed',
      },
    ],
    threadId: 'thread-1',
    usage: [
      {
        billedCostUsd: '0.004215000000',
        inputTokens: 812,
        model: 'claude-sonnet-5',
        outputTokens: 156,
        provider: 'anthropic',
      },
    ],
  };
}

describe('formatThreadDebugBundle', () => {
  it('renders a fully-populated bundle in the pinned golden format', () => {
    const output = formatThreadDebugBundle(makeGoldenFixture());
    expect(output).toMatchSnapshot();
  });

  it('exposes the pinned format constants', () => {
    expect(DEBUG_BUNDLE_FORMAT_VERSION).toBe(1);
    expect(DEBUG_BUNDLE_DEFAULT_MAX_BYTES).toBe(200_000);
  });

  it('elides oldest transcript messages until the byte budget is met', () => {
    const bigContent = (seed: number) => `${'A'.repeat(20_000)}-${seed}`;
    const messages = Array.from({ length: 30 }, (_, index) => ({
      content: index < 24 ? bigContent(index) : `small-${index}`,
      createdAt: `2026-07-23T12:${String(index).padStart(2, '0')}:00.000Z`,
      id: `msg-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
    }));
    // Ensure the newest message is 'assistant' so the protected window (last
    // message +- 2) lands entirely inside the small tail messages.
    messages[messages.length - 1] = {
      ...(messages.at(-1) as (typeof messages)[number]),
      role: 'assistant',
    };

    const fixture: ThreadDebugBundleData = {
      diagnosticEvents: [],
      environment: {
        appVersion: '1.2.3',
        generatedAt: '2026-07-23T12:05:00.000Z',
        platform: 'darwin',
        sessionId: 'session-fixed-1',
      },
      messages,
      priorFailures: null,
      run: null,
      runEvents: [],
      threadId: 'thread-bounds',
      usage: [],
    };

    const output = formatThreadDebugBundle(fixture, { maxBytes: 50_000 });
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(50_000);
    expect(output).toContain('Elision log');
    expect(output).toContain('[elided message');
  });

  it('never leaks a sensitive key value even after the final redaction pass', () => {
    const fixture = makeGoldenFixture();
    const output = formatThreadDebugBundle(fixture);
    expect(output).not.toContain('sk-live-123');
    expect(output).toContain('[REDACTED]');
  });
});

describe('collectThreadDebugBundleData', () => {
  function makeDiagRow(id: string, overrides: Record<string, unknown> = {}) {
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

  function makeStubDb() {
    const calls: { params: readonly unknown[] | undefined; sql: string }[] = [];

    const runRow = {
      completed_at: '2026-07-23T12:00:31.000Z',
      error: 'boom',
      id: 'run-failed',
      model: 'claude-sonnet-5',
      model_settings: { temperature: 0.1 },
      provider: 'anthropic',
      provider_options: null,
      runtime_kind: 'agent',
      started_at: '2026-07-23T12:00:00.000Z',
      status: 'failed',
    };

    const eventRows = [
      {
        detail: 'd3',
        duration_ms: 3,
        kind: 'k3',
        label: 'l3',
        metadata: null,
        occurred_at: '2026-07-23T12:00:03.000Z',
        sequence: 3,
        status: 's3',
      },
      {
        detail: 'd1',
        duration_ms: 1,
        kind: 'k1',
        label: 'l1',
        metadata: null,
        occurred_at: '2026-07-23T12:00:01.000Z',
        sequence: 1,
        status: 's1',
      },
      {
        detail: 'd2',
        duration_ms: 2,
        kind: 'k2',
        label: 'l2',
        metadata: null,
        occurred_at: '2026-07-23T12:00:02.000Z',
        sequence: 2,
        status: 's2',
      },
    ];

    const usageRows = [
      {
        billed_cost_usd: '0.01',
        input_tokens: 10,
        model: 'claude-sonnet-5',
        output_tokens: 5,
        provider: 'anthropic',
      },
    ];

    const messageRows = [
      { content: 'hi', createdAt: '2026-07-23T12:00:05.000Z', id: 'm1', role: 'user' },
    ];

    // Diagnostic correlation fan-out: runId query (5 rows, ids run-0..run-4),
    // threadId query (60 rows; the first 3 reuse run-0..run-2 ids to prove
    // dedupe), sinceMs/untilMs window query (60 rows; the first 5 reuse
    // thread-3..thread-7 ids to prove dedupe again). Overall unique count
    // (117) exceeds the 100 cap, so both dedupe AND capping are exercised.
    const diagByRun = Array.from({ length: 5 }, (_, index) =>
      makeDiagRow(`run-${index}`, { fingerprint: `fp-run-${index}`, run_id: 'run-failed' })
    );
    const diagByThread = Array.from({ length: 60 }, (_, index) =>
      index < 3
        ? makeDiagRow(`run-${index}`, { fingerprint: `fp-run-${index}`, run_id: 'run-failed' })
        : makeDiagRow(`thread-${index}`, { thread_id: 'thread-1' })
    );
    const diagByWindow = Array.from({ length: 60 }, (_, index) =>
      index < 5
        ? makeDiagRow(`thread-${index + 3}`, { thread_id: 'thread-1' })
        : makeDiagRow(`window-${index}`)
    );

    const db: DebugBundleDatabase = {
      query: async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        calls.push({ params, sql });
        if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
          return { rows: [runRow] as unknown as T[] };
        }
        if (sql.includes('FROM brainstrike_assistant_run_events')) {
          return { rows: eventRows as unknown as T[] };
        }
        if (sql.includes('FROM brainstrike_assistant_run_usage')) {
          return { rows: usageRows as unknown as T[] };
        }
        if (sql.includes('FROM mastra_messages')) {
          return { rows: messageRows as unknown as T[] };
        }
        if (sql.includes('FROM brainstrike_diagnostic_events')) {
          if (sql.includes('COUNT(*)')) {
            return {
              rows: [
                {
                  count: 7,
                  first_seen: '2026-07-16T09:00:00.000Z',
                  last_seen: '2026-07-23T12:00:30.000Z',
                },
              ] as unknown as T[],
            };
          }
          if (sql.includes('run_id = $1') && !sql.includes('thread_id')) {
            return { rows: diagByRun as unknown as T[] };
          }
          if (sql.includes('thread_id = $1')) {
            return { rows: diagByThread as unknown as T[] };
          }
          if (sql.includes('occurred_at >=')) {
            return { rows: diagByWindow as unknown as T[] };
          }
        }
        throw new Error(`Unexpected SQL in stub: ${sql}`);
      },
    };

    return { calls, db };
  }

  it('selects the failed-run-first row via the ORDER BY clause and null-safe params', async () => {
    const { calls, db } = makeStubDb();
    const data = await collectThreadDebugBundleData(db, { threadId: 'thread-1' });

    expect(data.run?.id).toBe('run-failed');
    expect(data.run?.status).toBe('failed');
    const runQuery = calls.find((call) =>
      call.sql.includes('FROM brainstrike_assistant_thread_runs')
    );
    expect(runQuery?.params).toEqual(['thread-1', null]);
  });

  it('passes run-event ordering through untouched (trusts the SQL ORDER BY)', async () => {
    const { db } = makeStubDb();
    const data = await collectThreadDebugBundleData(db, { threadId: 'thread-1' });
    expect(data.runEvents.map((event) => event.sequence)).toEqual([3, 1, 2]);
  });

  it('dedupes correlated diagnostic events by id and caps the result at 100', async () => {
    const { db } = makeStubDb();
    const data = await collectThreadDebugBundleData(db, { threadId: 'thread-1' });

    expect(data.diagnosticEvents).toHaveLength(100);
    expect(new Set(data.diagnosticEvents.map((event) => event.id)).size).toBe(100);
    expect(data.priorFailures).toEqual({
      count: 7,
      firstSeenMs: Date.parse('2026-07-16T09:00:00.000Z'),
      lastSeenMs: Date.parse('2026-07-23T12:00:30.000Z'),
    });
  });
});

describe('buildThreadDebugBundle', () => {
  it('collects then formats in one call', async () => {
    const db: DebugBundleDatabase = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes('FROM brainstrike_diagnostic_events')) {
          return { rows: [] as unknown as T[] };
        }
        return { rows: [] as unknown as T[] };
      },
    };
    const output = await buildThreadDebugBundle(db, { threadId: 'thread-empty' });
    expect(output).toContain('# BrainStrike Debug Bundle');
    expect(output).toContain('thread-empty');
  });
});
