import * as agent from '@brainstrike/agent';
import { deriveEffectiveInputBudget } from '@brainstrike/assistant-contract/context-budget';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCompactionRange } from '../../assistant-server/compaction-range-repository';
import {
  createContextOverflowRecovery,
  resolveCompactionInputBudget,
  runPreRequestCompaction,
} from '../../assistant-server/conversation-compaction';

const { conversationCompactionDebug } = vi.hoisted(() => ({
  conversationCompactionDebug: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      if (args[0] !== 'ConversationCompaction') {
        return real;
      }
      return {
        ...real,
        debug: (...debugArgs: Parameters<typeof real.debug>) => {
          conversationCompactionDebug(...debugArgs);
          real.debug(...debugArgs);
        },
      };
    },
  };
});

const validSummary = 'Goal:\nG\nState:\nS\nDecisions:\nD\nNext:\nN\nFiles touched:\nF';

function textMessage(id: string, text: string, role: string, createdAt: string) {
  return {
    content: { format: 2, parts: [{ text, type: 'text' }] },
    createdAt: new Date(createdAt),
    id,
    resourceId: 'resource-1',
    role,
    threadId: 'thread-1',
    type: 'v2',
  };
}

function messages() {
  return [
    textMessage('old-1', 'old one', 'user', '2026-08-01T00:00:00.000Z'),
    textMessage('old-2', 'old two', 'assistant', '2026-08-02T00:00:00.000Z'),
    textMessage('tail', 'x'.repeat(80_000), 'assistant', '2026-08-03T00:00:00.000Z'),
    textMessage('current', 'continue', 'user', '2026-08-04T00:00:00.000Z'),
  ];
}

interface FakeStoredMessage {
  readonly content: unknown;
  readonly createdAt: Date;
  readonly id: string;
  readonly resourceId: string;
  readonly role: string;
  readonly threadId: string;
  readonly type: string;
}

function fakeStore(rows: readonly FakeStoredMessage[] = messages()) {
  return {
    listMessages: vi.fn(async () => ({
      hasMore: false,
      messages: rows,
      page: 0,
      perPage: false,
      total: rows.length,
    })),
    saveMessages: vi.fn(async ({ messages: saved }: { messages: unknown[] }) => ({
      messages: saved,
    })),
  };
}

function rangeRecorder(resetFileReads = vi.fn(), resetLoopGuards = vi.fn()) {
  const database = {
    transaction: async <T>(
      callback: (tx: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<T>
    ) =>
      await callback({
        query: vi.fn(async () => ({ rows: [{ compactionMessageId: 'summary-1' }] })),
      }),
  };
  return {
    record: (input: Parameters<typeof recordCompactionRange>[0]) =>
      recordCompactionRange(input, {
        getDatabase: async () => database as never,
        resetFileReads,
        resetLoopGuards,
      }),
    resetFileReads,
    resetLoopGuards,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    estimateVisibleTokens: vi.fn(() => 1),
    generateSummary: vi.fn(async () => ({
      inputTokens: 100,
      outputTokens: 20,
      text: validSummary,
    })),
    listCompactionRanges: vi.fn(async () => []),
    listToolProjectionRewrites: vi.fn(async () => new Map()),
    makeId: vi.fn(() => 'summary-1'),
    now: vi.fn(() => new Date('2026-08-09T12:00:00.000Z')),
    recordMessageParent: vi.fn(async () => undefined),
    recordRange: vi.fn(async (_input: Parameters<typeof recordCompactionRange>[0]) => undefined),
    resolvePromptBaselineTokens: vi.fn(async () => undefined),
    runRecencyPrune: vi.fn(async () => ({ prunedCount: 0 })),
    ...overrides,
  };
}

describe('pre-request conversation compaction trigger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a strict no-op below 90 percent', async () => {
    const store = fakeStore();
    const deps = dependencies({ estimateVisibleTokens: vi.fn(() => 89) });
    const projectionSpy = vi.spyOn(agent, 'projectCompactionMessages');
    const result = await runPreRequestCompaction(
      {
        memoryStore: store as never,
        requestMessages: [],
        runId: 'run-1',
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
        signal: new AbortController().signal,
      },
      { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
    );

    expect(result).toEqual({ kind: 'noop' });
    expect(deps.runRecencyPrune).not.toHaveBeenCalled();
    expect(deps.generateSummary).not.toHaveBeenCalled();
    expect(deps.recordRange).not.toHaveBeenCalled();
    expect(projectionSpy).not.toHaveBeenCalled();
    projectionSpy.mockRestore();
  });

  it('counts legacy flattened content when deciding whether to trigger', async () => {
    const store = fakeStore([
      textMessage('old-user', 'old', 'user', '2026-08-01T00:00:00.000Z'),
      {
        ...textMessage('legacy-assistant', '', 'assistant', '2026-08-02T00:00:00.000Z'),
        content: { content: 'x'.repeat(400) },
      },
      textMessage('current-user', 'continue', 'user', '2026-08-03T00:00:00.000Z'),
    ]);
    const deps = dependencies({
      estimateVisibleTokens: agent.estimateCompactionMessageTokens,
    });

    await runPreRequestCompaction(
      {
        memoryStore: store as never,
        requestMessages: [],
        runId: 'run-legacy',
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
        signal: new AbortController().signal,
      },
      { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
    );

    expect(deps.runRecencyPrune).toHaveBeenCalledOnce();
  });

  it('fires at exactly 90 percent and runs recency pruning before summarization', async () => {
    const calls: string[] = [];
    const recorder = rangeRecorder();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 90),
      generateSummary: vi.fn(async () => {
        calls.push('summarize');
        return { inputTokens: 100, outputTokens: 20, text: validSummary };
      }),
      recordRange: vi.fn(recorder.record),
      runRecencyPrune: vi.fn(async () => {
        calls.push('prune');
        return { prunedCount: 1 };
      }),
    });
    const result = await runPreRequestCompaction(
      {
        memoryStore: fakeStore() as never,
        requestMessages: [],
        runId: 'run-1',
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
        signal: new AbortController().signal,
      },
      { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
    );

    expect(result).toMatchObject({ kind: 'agentic', usage: { source: 'compaction-summary' } });
    expect(calls).toEqual(['prune', 'summarize']);
    expect(deps.recordMessageParent).toHaveBeenCalledWith({
      messageId: 'summary-1',
      parentId: null,
      resourceId: 'resource-1',
      threadId: 'thread-1',
    });
    expect(recorder.resetLoopGuards).toHaveBeenCalledOnce();
    expect(recorder.resetFileReads).toHaveBeenCalledOnce();
  });

  it('fires when the prompt baseline plus messages reaches exactly 90 percent', async () => {
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 80),
      resolvePromptBaselineTokens: vi.fn(async () => 10),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: fakeStore() as never,
          requestMessages: [],
          runId: 'run-baseline-threshold',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toMatchObject({ kind: 'agentic' });
    expect(deps.runRecencyPrune).toHaveBeenCalledOnce();
    expect(deps.generateSummary).toHaveBeenCalledOnce();
  });

  it('compacts below the old message-only threshold when the baseline crosses 90 percent', async () => {
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 89),
      resolvePromptBaselineTokens: vi.fn(async () => 12),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: fakeStore() as never,
          requestMessages: [],
          runId: 'run-baseline-regression',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toMatchObject({ kind: 'agentic' });
    expect(deps.runRecencyPrune).toHaveBeenCalledOnce();
  });

  it.each([
    ['has no prior calibration row', async () => undefined],
    ['cannot read the prior calibration row', async () => Promise.reject(new Error('read failed'))],
  ])('preserves message-only behavior when the baseline %s', async (_label, resolveBaseline) => {
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 89),
      resolvePromptBaselineTokens: vi.fn(resolveBaseline),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: fakeStore() as never,
          requestMessages: [],
          runId: 'run-baseline-unavailable',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toEqual({ kind: 'noop' });

    expect(deps.runRecencyPrune).not.toHaveBeenCalled();
    expect(conversationCompactionDebug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'conversation_compaction_baseline_unavailable' })
    );
  });

  it('warns and avoids agentic compaction thrash when the baseline alone exceeds target', async () => {
    const records: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => records.push(record));
    const store = fakeStore();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      resolvePromptBaselineTokens: vi.fn(async () => 71),
    });

    try {
      for (let turn = 0; turn < 3; turn += 1) {
        await expect(
          runPreRequestCompaction(
            {
              memoryStore: store as never,
              requestMessages: [],
              runId: `run-baseline-over-target-${turn}`,
              runtimeData: {
                memory: { resourceId: 'resource-1', threadId: 'thread-1' },
                model: 'gpt-5.2',
                provider: 'openai',
              },
              signal: new AbortController().signal,
            },
            { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
          )
        ).resolves.toEqual({ kind: 'noop' });
      }
    } finally {
      removeLogListener();
    }

    const warnings = records.filter((record) =>
      record.args.some(
        (arg) =>
          Boolean(arg && typeof arg === 'object') &&
          (arg as { code?: unknown }).code === 'conversation_compaction_baseline_exceeds_target'
      )
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.every((record) => record.level === LogLevel.WARN)).toBe(true);
    expect(warnings[0]?.args).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseline: 71, inputBudget: 100, threadId: 'thread-1' }),
      ])
    );
    expect(deps.runRecencyPrune).not.toHaveBeenCalled();
    expect(deps.generateSummary).not.toHaveBeenCalled();
    expect(deps.recordRange).not.toHaveBeenCalled();
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it('respects different effective input budgets from two model catalog entries', async () => {
    const gptRuntime = { model: 'gpt-5.2', provider: 'openai' } as const;
    const claudeRuntime = { model: 'claude-sonnet-5', provider: 'anthropic' } as const;
    const gptBudget = resolveCompactionInputBudget(gptRuntime);
    const claudeBudget = resolveCompactionInputBudget(claudeRuntime);
    const budgets = [gptBudget, claudeBudget];
    const usageBetweenThresholds = (0.9 * gptBudget + 0.9 * claudeBudget) / 2;

    expect(gptBudget).not.toBe(claudeBudget);
    expect(budgets).toContain(deriveEffectiveInputBudget(400_000, 128_000));
    for (const { budget, runtime } of [
      { budget: gptBudget, runtime: gptRuntime },
      { budget: claudeBudget, runtime: claudeRuntime },
    ]) {
      const deps = dependencies({
        estimateVisibleTokens: vi.fn(() => usageBetweenThresholds),
      });
      await runPreRequestCompaction(
        {
          memoryStore: fakeStore() as never,
          requestMessages: [],
          runId: 'run-1',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            ...runtime,
          },
          signal: new AbortController().signal,
        },
        deps as never
      );
      if (budget === Math.min(...budgets)) {
        expect(deps.runRecencyPrune).toHaveBeenCalledOnce();
      } else {
        expect(deps.runRecencyPrune).not.toHaveBeenCalled();
      }
    }
  });

  it('leaves history intact when the summarizer is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = fakeStore();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      generateSummary: vi.fn(async () => {
        throw controller.signal.reason;
      }),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: store as never,
          requestMessages: [],
          runId: 'run-1',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: controller.signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toEqual({ kind: 'noop' });
    expect(store.saveMessages).not.toHaveBeenCalled();
    expect(deps.recordMessageParent).not.toHaveBeenCalled();
    expect(deps.recordRange).not.toHaveBeenCalled();
  });

  it('leaves history intact after a transient summarizer provider failure', async () => {
    const store = fakeStore();
    const rateLimitError = Object.assign(new Error('Rate limited'), { statusCode: 429 });
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      generateSummary: vi.fn(async () => {
        throw rateLimitError;
      }),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: store as never,
          requestMessages: [],
          runId: 'run-1',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toEqual({ kind: 'noop' });
    expect(store.saveMessages).not.toHaveBeenCalled();
    expect(deps.recordRange).not.toHaveBeenCalled();
  });

  it('commits deterministic fallback for a summarizer schema failure', async () => {
    const store = fakeStore();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      generateSummary: vi.fn(async () => {
        throw new agent.AgenticCompactionSummarySchemaError({
          inputTokens: 40,
          outputTokens: 10,
        });
      }),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: store as never,
          requestMessages: [],
          runId: 'run-1',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toMatchObject({
      kind: 'deterministic',
      usage: { inputTokens: 40, outputTokens: 10, source: 'compaction-summary' },
    });
    expect(store.saveMessages).toHaveBeenCalledOnce();
    expect(deps.recordRange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deterministic' })
    );
  });

  it('commits deterministic fallback for a summarizer context-overflow failure', async () => {
    const store = fakeStore();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      generateSummary: vi.fn(async () => {
        throw Object.assign(new Error('Summary prompt exceeded provider context'), {
          code: 'context_length_exceeded',
        });
      }),
    });

    await expect(
      runPreRequestCompaction(
        {
          memoryStore: store as never,
          requestMessages: [],
          runId: 'run-1',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'gpt-5.2',
            provider: 'openai',
          },
          signal: new AbortController().signal,
        },
        { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
      )
    ).resolves.toEqual({ kind: 'deterministic' });
    expect(store.saveMessages).toHaveBeenCalledOnce();
    expect(deps.recordRange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deterministic' })
    );
  });
});

describe('deterministic context-overflow fallback', () => {
  it('commits an honest one-line index without an LLM call and resets caches once', async () => {
    const providerCall = vi.fn();
    const recorder = rangeRecorder();
    const deps = dependencies({
      estimateVisibleTokens: vi.fn(() => 100),
      generateSummary: providerCall,
      recordRange: vi.fn(recorder.record),
    });
    const store = fakeStore();
    const recover = createContextOverflowRecovery(
      {
        memoryStore: store as never,
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
      },
      { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
    );

    await expect(recover()).resolves.toEqual({ applied: true });
    expect(providerCall).not.toHaveBeenCalled();
    expect(recorder.resetLoopGuards).toHaveBeenCalledOnce();
    expect(recorder.resetFileReads).toHaveBeenCalledOnce();
    expect(deps.recordRange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deterministic' })
    );
    const recordCall = deps.recordRange.mock.calls[0]?.[0];
    expect(recordCall?.compactedMessageIds.length).toBeGreaterThan(0);
    const savedMessage = store.saveMessages.mock.calls[0]?.[0].messages[0] as {
      content: {
        metadata: { custom: Record<string, { droppedSummaryLine: string }> };
        parts: Array<{ text: string }>;
      };
    };
    const droppedSummaryLine = Object.values(savedMessage.content.metadata.custom)[0]
      ?.droppedSummaryLine;
    expect(droppedSummaryLine).toMatch(
      /^Deterministic fallback: dropped \d+ messages spanning .* after a provider context-overflow error; no summarization model ran\.$/
    );
    expect(savedMessage.content.parts[0]?.text).toBe(droppedSummaryLine);
  });

  it('uses the injected estimator units for deterministic reclaim selection', async () => {
    const deps = dependencies({
      estimateVisibleTokens: vi.fn((visibleMessages: readonly unknown[]) =>
        visibleMessages.length === 1 ? 40 : 100
      ),
    });
    const recover = createContextOverflowRecovery(
      {
        memoryStore: fakeStore() as never,
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
      },
      { ...deps, resolveInputBudget: vi.fn(() => 100) } as never
    );

    await expect(recover()).resolves.toEqual({ applied: true });
    expect(deps.recordRange).toHaveBeenCalledWith(
      expect.objectContaining({ compactedMessageIds: ['old-1'] })
    );
  });

  it('subtracts the prompt baseline from the deterministic message-side target', async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        textMessage(
          `old-${index + 1}`,
          `old ${index + 1} ${'x'.repeat(80_000)}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `2026-08-0${index + 1}T00:00:00.000Z`
        )
      ),
      textMessage('current', 'continue', 'user', '2026-08-09T00:00:00.000Z'),
    ];
    const deps = dependencies({
      estimateVisibleTokens: vi.fn((visibleMessages: readonly unknown[]) =>
        visibleMessages.length === 1 ? 1000 : 8000
      ),
      resolvePromptBaselineTokens: vi.fn(async () => 3000),
    });
    const recover = createContextOverflowRecovery(
      {
        memoryStore: fakeStore(rows) as never,
        runtimeData: {
          memory: { resourceId: 'resource-1', threadId: 'thread-1' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
      },
      { ...deps, resolveInputBudget: vi.fn(() => 10_000) } as never
    );

    await expect(recover()).resolves.toEqual({ applied: true });
    expect(deps.recordRange).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedMessageIds: ['old-1', 'old-2', 'old-3', 'old-4'],
      })
    );
  });
});
