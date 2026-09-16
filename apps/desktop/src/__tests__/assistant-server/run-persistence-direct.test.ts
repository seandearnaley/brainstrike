/**
 * Direct-drive run-persistence tests (moved verbatim from the pre-split
 * assistant-server.integration.test.ts, BST-1028). PURE lane: the BST-972 A1
 * injection made the database provider a literal argument, so these need no
 * module mocks, no HTTP harness, and no real PGlite — the schema-backed
 * halves live in run-event-schema-provenance / hook-run-outcome integration
 * suites.
 */
import type { StreamChunk } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopAssistantServerLogger } from '../../assistant-server/logger';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
  persistDesktopToolCallTelemetry,
} from '../../assistant-server/run-persistence';
import { DbHostRequestTimeoutError } from '../../db-host-manager';
import { resetDesktopDatabaseWorkSchedulerForTests } from '../../platform/desktop-database-work';

// File-local double — the pre-split suite shared one across every describe.
const mockDesktopDatabase = {
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(),
};

beforeEach(() => {
  resetDesktopDatabaseWorkSchedulerForTests();
  mockDesktopDatabase.query.mockReset();
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
});

describe('run-event persistence tap transience', () => {
  it('passes a context-breakdown chunk through UNPERSISTED (transient, shell-output precedent)', async () => {
    const runId = 'run-breakdown-transience';
    const breakdownChunk = {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 9,
        provenance: 'heuristic',
        systemInstructionsTokens: 1234,
      },
      type: 'context-breakdown',
    } as unknown as StreamChunk;

    async function* source(): AsyncIterable<StreamChunk> {
      yield breakdownChunk;
      yield {
        event: {
          id: 'ev-1',
          kind: 'run.finished',
          label: 'Assistant run finished',
          status: 'completed',
          timestamp: '2026-07-18T00:00:00.000Z',
        },
        type: 'run-event',
      } as unknown as StreamChunk;
    }

    const seen: StreamChunk[] = [];
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      runId,
      [],
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }

    // Pass-through: the breakdown chunk reaches the mapper untouched.
    expect(seen[0]).toBe(breakdownChunk);
    // Never persisted: no INSERT parameter carries the breakdown figures,
    // while the run-event on the same stream WAS persisted.
    const persistedValues = mockDesktopDatabase.query.mock.calls
      .map((call) => call[1])
      .filter((params): params is unknown[] => Array.isArray(params))
      .flat();
    expect(persistedValues).not.toContain(1234);
    expect(persistedValues).toContain('run.finished');
  });

  it('stamps the host leg on the pauses of its own turn, never on a continuation pause', async () => {
    // The host leg is the ONE place that knows which durable
    // `brainstrike_assistant_thread_runs` row is streaming — the same knowledge
    // it already stamps on every run event. A pause of this turn (the root's
    // own, or a delegated child's card) carries it so the history topology
    // adapter can anchor the suspended message; a CHILD-CONTINUATION pause does
    // not, because a continuation leg's `turn_message_id` is the continuation
    // id, not a root message, so anchoring a root edge on it would dangle.
    const runId = 'run-host-leg-1';
    const rootPause = {
      runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
      toolCallId: 'call-root',
      toolName: 'brainstrike.executeCommand',
      type: 'tool-approval-required',
    } as unknown as StreamChunk;
    const delegatedPause = {
      chunk: {
        runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
        toolCallId: 'call-child',
        toolName: 'brainstrike.askUser',
        type: 'tool-suspend-required',
      },
      identity: {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
        parentToolCallId: 'delegate-1',
        personaId: 'explore',
      },
      messageId: 'child-message',
      type: 'delegated-conversation-chunk',
    } as unknown as StreamChunk;
    const continuationPause = {
      chunk: {
        runId: '11b02e1c-3fae-410b-9697-f7175c77693d',
        toolCallId: 'call-continuation',
        toolName: 'brainstrike.askUser',
        type: 'tool-suspend-required',
      },
      continuationId: 'continuation-1',
      messageId: 'continuation-message',
      nativeRunId: '11b02e1c-3fae-410b-9697-f7175c77693d',
      threadId: 'child-thread',
      type: 'child-continuation-chunk',
    } as unknown as StreamChunk;

    async function* source(): AsyncIterable<StreamChunk> {
      yield rootPause;
      yield delegatedPause;
      yield continuationPause;
    }

    const seen: StreamChunk[] = [];
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      runId,
      [],
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }

    expect(seen[0]).toMatchObject({ hostRunId: runId, toolCallId: 'call-root' });
    expect(seen[1]).toMatchObject({ chunk: { hostRunId: runId, toolCallId: 'call-child' } });
    // Identity, not a shape match: a continuation pause passes through
    // untouched, so no stamp can reach a leg whose turn link is not a root
    // message.
    expect(seen[2]).toBe(continuationPause);
  });

  it('upserts one event with retry evidence when the timed-out insert later completes', async () => {
    const persistedEvents = new Map<string, string | null>();
    let completeTimedOutInsert!: () => void;
    const timedOutInsertCompletion = new Promise<void>((resolve) => {
      completeTimedOutInsert = resolve;
    });
    const timeout = new DbHostRequestTimeoutError({
      pendingCount: 2,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    mockDesktopDatabase.query.mockImplementation(async (sql, params) => {
      if (!sql.includes('INSERT INTO brainstrike_assistant_run_events')) {
        return { rows: [] };
      }
      const eventId = params?.[0];
      const metadata = params?.[7];
      if (typeof eventId !== 'string') {
        throw new Error('Expected a run-event id.');
      }
      if (mockDesktopDatabase.query.mock.calls.length === 1) {
        void timedOutInsertCompletion.then(() => {
          persistedEvents.set(eventId, typeof metadata === 'string' ? metadata : null);
        });
        throw timeout;
      }
      await timedOutInsertCompletion;
      persistedEvents.set(eventId, typeof metadata === 'string' ? metadata : null);
      return { rows: [] };
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        event: {
          id: 'event-idempotent-retry',
          kind: 'run.step.started',
          label: 'Step started',
          metadata: { authorization: 'must-not-persist' },
          status: 'running',
          timestamp: '2026-08-25T00:00:00.000Z',
        },
        type: 'run-event',
      } as StreamChunk;
    }

    const drain = async (): Promise<void> => {
      for await (const _chunk of observeDesktopAssistantRunEvents(
        source(),
        'run-idempotent-retry',
        [],
        async () => mockDesktopDatabase
      )) {
        // Drain the persistence tap so its ordered queue flushes.
      }
    };
    const drainPromise = drain();
    await vi.waitFor(() => expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2));
    expect(persistedEvents.size).toBe(0);
    completeTimedOutInsert();
    await drainPromise;

    expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2);
    expect(mockDesktopDatabase.query.mock.calls[0]?.[1]?.[0]).toBe('event-idempotent-retry');
    expect(mockDesktopDatabase.query.mock.calls[1]?.[1]?.[0]).toBe('event-idempotent-retry');
    expect(persistedEvents.size).toBe(1);
    const persistedMetadata = JSON.parse(persistedEvents.get('event-idempotent-retry') ?? '{}');
    expect(persistedMetadata).not.toHaveProperty('authorization');
    expect(persistedMetadata).toMatchObject({
      databaseRetry: {
        attempt: 2,
        reason: 'host-saturated-timeout',
      },
    });
  });
});

describe('child-run-usage durable persistence (BST-953)', () => {
  function usageInsertCalls(): unknown[][] {
    return mockDesktopDatabase.query.mock.calls
      .filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO brainstrike_assistant_run_usage')
      )
      .map((call) => call[1] as unknown[]);
  }

  async function drive(
    chunks: StreamChunk[],
    observerTarget: { model: string; provider: string } | undefined
  ): Promise<StreamChunk[]> {
    async function* source(): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    const seen: StreamChunk[] = [];
    for await (const chunk of persistDesktopChildRunUsage(
      source(),
      'run-child-usage',
      observerTarget,
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }
    return seen;
  }

  it('persists a subagent chunk as a run_kind=subagent row and forwards it', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: {
        estimated: false,
        inputTokens: 42,
        model: 'gpt-5.2',
        outputTokens: 7,
        personaId: 'explore',
        provider: 'openai',
        source: 'subagent',
      },
    } as unknown as StreamChunk;

    const seen = await drive([chunk], undefined);

    expect(seen[0]).toBe(chunk);
    const inserts = usageInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.arrayContaining(['run-child-usage', 'gpt-5.2', 'openai', 42, 7, 'subagent'])
    );
  });

  it('persists provider-attributed compaction-summary usage under the parent run', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: {
        estimated: false,
        inputTokens: 1200,
        model: 'gpt-5.2',
        outputTokens: 180,
        provider: 'openai',
        source: 'compaction-summary',
      },
    } as unknown as StreamChunk;

    await drive([chunk], undefined);

    expect(usageInsertCalls()[0]).toEqual(
      expect.arrayContaining([
        'run-child-usage',
        'gpt-5.2',
        'openai',
        1200,
        180,
        'compaction-summary',
      ])
    );
  });

  it('attributes an OM cycle row to the RESOLVED OBSERVER target, never the chat model', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: {
        estimated: true,
        inputTokens: 24_000,
        outputTokens: 900,
        source: 'om-observation',
      },
    } as unknown as StreamChunk;

    await drive([chunk], { model: 'google/gemini-2.5-flash', provider: 'openrouter' });

    const inserts = usageInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.arrayContaining([
        'run-child-usage',
        'google/gemini-2.5-flash',
        'openrouter',
        24_000,
        900,
        'om-observation',
      ])
    );
  });

  it('drops an unattributable OM row visibly (no observer target) but still forwards the chunk', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: { estimated: true, inputTokens: 100, outputTokens: 10, source: 'om-reflection' },
    } as unknown as StreamChunk;

    const seen = await drive([chunk], undefined);

    expect(seen[0]).toBe(chunk);
    expect(usageInsertCalls()).toHaveLength(0);
  });

  it('skips local-observer rows (local inference is unbilled)', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: { estimated: true, inputTokens: 100, outputTokens: 10, source: 'om-observation' },
    } as unknown as StreamChunk;

    await drive([chunk], { model: 'gemma-3n', provider: 'local' });

    expect(usageInsertCalls()).toHaveLength(0);
  });
});

describe('tool-call telemetry durable persistence (BST-1190)', () => {
  it('batches every sample into ONE typed insert, consumes the internal chunk, and preserves other chunks', async () => {
    mockDesktopDatabase.query.mockResolvedValue({
      rows: [{ id: 'row-1' }, { id: 'row-2' }],
    });
    const privateText = 'PRIVATE_PATTERN:/PRIVATE_PATH:COMMAND_TEXT';
    const grepOccurredAt = Date.UTC(2026, 7, 7, 10, 0, 0);
    const execOccurredAt = Date.UTC(2026, 7, 7, 10, 0, 5);
    const telemetryChunk = {
      type: 'tool-call-telemetry',
      value: [
        {
          isPaginationFollowup: true,
          modelFacingChars: 321,
          occurredAt: grepOccurredAt,
          toolId: 'grepSearch',
          truncated: true,
          unsafeFixture: privateText,
          zeroMatch: false,
        },
        {
          isPaginationFollowup: true,
          modelFacingChars: 99,
          occurredAt: execOccurredAt,
          toolId: 'executeCommand',
          truncated: false,
          unsafeFixture: privateText,
          zeroMatch: true,
        },
      ],
    } as unknown as StreamChunk;
    const passthrough = { payload: { text: 'ok' }, type: 'text-delta' } as unknown as StreamChunk;

    async function* source(): AsyncIterable<StreamChunk> {
      yield telemetryChunk;
      yield passthrough;
    }

    const seen: StreamChunk[] = [];
    for await (const chunk of persistDesktopToolCallTelemetry(
      source(),
      'run-telemetry',
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }

    expect(seen).toEqual([passthrough]);
    const inserts = mockDesktopDatabase.query.mock.calls.filter((call) =>
      String(call[0]).includes('INSERT INTO brainstrike_tool_call_telemetry')
    );
    // ONE round-trip for the whole batch (review fix), not one per sample.
    expect(inserts).toHaveLength(1);
    const [sql, params] = inserts[0] as [string, unknown[]];
    // Every array parameter carries an explicit ::type[] cast so PGlite never
    // resolves a bare `null` to `text` (review fix).
    expect(sql).toContain('unnest(');
    expect(sql).toContain('$5::integer[]');
    expect(sql).toContain('$6::boolean[]');
    expect(sql).toContain('$7::boolean[]');
    expect(sql).toContain('$8::boolean[]');
    expect(params[0]).toBe('run-telemetry');
    expect(params[1]).toEqual([expect.any(String), expect.any(String)]);
    expect(params[2]).toEqual(['grepSearch', 'executeCommand']);
    expect(params[3]).toEqual([
      new Date(grepOccurredAt).toISOString(),
      new Date(execOccurredAt).toISOString(),
    ]);
    expect(params[4]).toEqual([321, 99]);
    expect(params[5]).toEqual([true, false]);
    // zero_match/is_pagination_followup are only ever populated for the two
    // search tools; every other tool id forces them to null/false.
    expect(params[6]).toEqual([false, null]);
    expect(params[7]).toEqual([true, false]);
    expect(JSON.stringify(inserts)).not.toContain(privateText);
  });

  it('is a no-op for an empty telemetry chunk (no INSERT, no thrown error)', async () => {
    const telemetryChunk = { type: 'tool-call-telemetry', value: [] } as unknown as StreamChunk;

    async function* source(): AsyncIterable<StreamChunk> {
      yield telemetryChunk;
    }

    const seen: StreamChunk[] = [];
    for await (const chunk of persistDesktopToolCallTelemetry(
      source(),
      'run-telemetry',
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }

    expect(seen).toEqual([]);
    expect(mockDesktopDatabase.query).not.toHaveBeenCalled();
  });
});

it('records the rejected delegated usage identity and still rejects the stream', async () => {
  const errorLog = vi.spyOn(desktopAssistantServerLogger, 'error');
  const rejection = new Error('controlled delegated usage rejection');
  mockDesktopDatabase.query.mockRejectedValueOnce(rejection);
  const value = {
    delegation: {
      parentRuntimeRunId: 'native-parent',
      parentToolCallId: 'delegate-call',
      resourceId: 'child-resource',
      threadId: 'child-thread',
    },
    estimated: false,
    inputTokens: 42,
    model: 'x-ai/grok-4.6',
    outputTokens: 7,
    personaId: 'explore',
    provider: 'openrouter',
    source: 'subagent' as const,
  };
  async function* source(): AsyncIterable<StreamChunk> {
    yield { type: 'child-run-usage', value };
  }
  try {
    const iterator = persistDesktopChildRunUsage(
      source(),
      'host-run',
      undefined,
      async () => mockDesktopDatabase
    );
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBe(rejection);
    expect(errorLog).toHaveBeenCalledWith('Failed to persist bound delegated usage', {
      code: 'assistant_delegated_usage_write_failed',
      delegation: value.delegation,
      error: rejection,
      model: value.model,
      personaId: value.personaId,
      provider: value.provider,
      runId: 'host-run',
    });
  } finally {
    errorLog.mockRestore();
  }
});
