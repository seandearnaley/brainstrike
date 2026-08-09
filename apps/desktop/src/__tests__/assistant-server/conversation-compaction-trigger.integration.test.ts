import { deriveEffectiveInputBudget } from '@brainstrike/assistant-contract/context-budget';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCompactionRange } from '../../assistant-server/compaction-range-repository';
import {
  createContextOverflowRecovery,
  resolveCompactionInputBudget,
  runPreRequestCompaction,
} from '../../assistant-server/conversation-compaction';

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

function fakeStore(rows = messages()) {
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
    recordRange: vi.fn(async (_input: Parameters<typeof recordCompactionRange>[0]) => undefined),
    runRecencyPrune: vi.fn(async () => ({ prunedCount: 0 })),
    ...overrides,
  };
}

describe('pre-request conversation compaction trigger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a strict no-op below 90 percent', async () => {
    const store = fakeStore();
    const deps = dependencies({ estimateVisibleTokens: vi.fn(() => 89) });
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
    expect(recorder.resetLoopGuards).toHaveBeenCalledOnce();
    expect(recorder.resetFileReads).toHaveBeenCalledOnce();
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
});
