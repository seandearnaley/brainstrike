import { fault } from '@brainstrike/assistant-contract';
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  HostContextSummarySchemaError,
  prepareCompactedContext,
} from '../src/context-compaction.js';
import type { HostRunState } from '../src/core-state.js';
import type { HostPreparedStep, HostProjectionRewrite } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Input = Parameters<typeof prepareCompactedContext>[0];

function chain(count: number): HostRunState[] {
  return Array.from({ length: count }, (_, index) => ({ id: `run-${index}` }) as HostRunState);
}

/** Each turn: a 3-token question and an answer of ceil((chars + 9) / 4) tokens. */
function turns(count: number, chars: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index): ModelMessage[] => [
    { content: `question ${index}`, role: 'user' },
    {
      content: [{ text: `answer ${index} ${'x'.repeat(chars)}`, type: 'text' }],
      role: 'assistant',
    },
  ]).flat();
}

const receipt = { modelId: 'gpt-6-sol', usage: { inputTokens: 300, outputTokens: 40 } };
const summary = { ...receipt, text: 'Goal: g\nState: s' };

/**
 * Six turns of 10,006 estimated tokens (60,036) against a 40,000-token budget:
 * past the trigger; the protect window keeps run-4 and run-5 (20,012 tokens).
 */
async function pastTrigger(overrides: Partial<Input> = {}) {
  const committed: Compacted[] = [];
  const prepared = await prepareCompactedContext({
    chain: chain(6),
    commit: async (event) => {
      committed.push(event);
    },
    compactions: [],
    inputTokenLimit: 40_000,
    messages: turns(6, 40_000),
    signal: new AbortController().signal,
    summarize: async () => summary,
    ...overrides,
  });
  return { committed, prepared };
}

describe('prepareCompactedContext', () => {
  it('commits nothing below the trigger ratio and returns the branch unchanged', async () => {
    const commit = vi.fn(async () => undefined);
    const summarize = vi.fn(async () => summary);
    const messages = turns(4, 400);
    const prepared = await prepareCompactedContext({
      chain: chain(4),
      commit,
      compactions: [],
      inputTokenLimit: 20_000,
      messages,
      signal: new AbortController().signal,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(prepared).toEqual({ messages });
  });

  it('summarizes every unprotected turn past the trigger and commits the summarizer receipt', async () => {
    const summarize = vi.fn(async (_transcript: string) => summary);
    const { committed, prepared } = await pastTrigger({ summarize });
    expect(committed).toEqual([
      {
        compactedRunIds: ['run-0', 'run-1', 'run-2', 'run-3'],
        kind: 'agentic',
        modelId: 'gpt-6-sol',
        reason: 'pre-request',
        runId: 'run-5',
        summary: summary.text,
        type: 'context.compacted',
        usage: receipt.usage,
      },
    ]);
    const transcript = summarize.mock.calls[0]?.[0] ?? '';
    expect(transcript.split('\n')).toHaveLength(8);
    expect(transcript).toContain('question 0');
    expect(transcript).not.toContain('question 4');
    expect(prepared.messages[0]).toEqual({ content: 'question 4', role: 'user' });
    expect(prepared.messages).toHaveLength(4);
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${summary.text}`);
  });

  it('keeps the newest 20,000 estimated tokens even past the trigger', async () => {
    const summarize = vi.fn(async () => summary);
    // Six turns of 1,006 tokens against 4,000: past the trigger, all inside the window.
    const { committed, prepared } = await pastTrigger({
      inputTokenLimit: 4000,
      messages: turns(6, 4000),
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    expect(prepared.messages).toHaveLength(12);
  });

  it('keeps a turn that called a plan or skill tool', async () => {
    const messages = turns(6, 40_000);
    messages[3] = {
      content: [
        { text: 'answer 1', type: 'text' },
        // The provider-facing (sanitized) name of brainstrike.askUser.
        { input: {}, toolCallId: 'call-ask', toolName: 'brainstrike_askUser', type: 'tool-call' },
      ],
      role: 'assistant',
    };
    messages[5] = {
      content: [
        {
          input: { name: 'review' },
          toolCallId: 'call-skill',
          toolName: 'skill',
          type: 'tool-call',
        },
      ],
      role: 'assistant',
    };
    const { committed, prepared } = await pastTrigger({ messages });
    expect(committed[0]?.compactedRunIds).toEqual(['run-0', 'run-3']);
    expect(
      prepared.messages.filter((message) => message.role === 'user').map((m) => m.content)
    ).toEqual(['question 1', 'question 2', 'question 4', 'question 5']);
  });

  it('falls back to dropping only the oldest turns that reach the target when the summarizer fails', async () => {
    const { committed, prepared } = await pastTrigger({
      // Target 35,000: reclaiming 25,036 of 60,036 takes three turns.
      inputTokenLimit: 50_000,
      summarize: async () => {
        throw new Error('provider unavailable');
      },
    });
    expect(committed).toEqual([
      {
        compactedRunIds: ['run-0', 'run-1', 'run-2'],
        kind: 'deterministic',
        reason: 'pre-request',
        runId: 'run-5',
        summarizerFailure: { code: 'boundary.internal', correlationId: expect.any(String) },
        summary:
          'Deterministic fallback: dropped 3 earlier turns (6 messages) after an agentic summarizer failure; no summarization model ran.',
        type: 'context.compacted',
      },
    ]);
    expect(prepared.messages[0]).toEqual({ content: 'question 3', role: 'user' });
    expect(prepared.note).toContain(committed[0]?.summary);
  });

  it('keeps the receipt of a schema-violating summary on the deterministic fallback', async () => {
    const { committed } = await pastTrigger({
      summarize: async () => {
        throw new HostContextSummarySchemaError(receipt);
      },
    });
    expect(committed[0]).toMatchObject({
      kind: 'deterministic',
      ...receipt,
      summarizerFailure: { code: 'compaction.summary-invalid', correlationId: expect.any(String) },
    });
  });

  it('records the run’s reading of a summarizer’s provider failure and the reference its cause is logged under', async () => {
    const providerFailure = new Error('401 from the provider');
    const classify = vi.fn((_cause: unknown) =>
      fault({
        category: 'authorization',
        code: 'provider.auth-failed',
        message: 'The provider rejected the credential.',
      })
    );
    const { committed } = await pastTrigger({
      classify,
      summarize: async () => {
        throw providerFailure;
      },
    });
    expect(classify).toHaveBeenCalledWith(providerFailure);
    expect(committed[0]?.summarizerFailure).toEqual({
      code: 'provider.auth-failed',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(committed[0]).not.toHaveProperty('modelId');
  });

  it('commits nothing when the run aborts during summarization', async () => {
    const controller = new AbortController();
    const abort = new Error('stopped');
    const commit = vi.fn(async () => undefined);
    await expect(
      pastTrigger({
        commit,
        signal: controller.signal,
        summarize: async () => {
          controller.abort(abort);
          throw abort;
        },
      })
    ).rejects.toBe(abort);
    expect(commit).not.toHaveBeenCalled();
  });

  it('applies committed compactions without committing again', async () => {
    const commit = vi.fn(async () => undefined);
    const earlier: Compacted = {
      compactedRunIds: ['run-0'],
      kind: 'agentic',
      reason: 'pre-request',
      runId: 'run-1',
      summary: 'Earlier summary.',
      type: 'context.compacted',
    };
    const prepared = await prepareCompactedContext({
      chain: chain(3),
      commit,
      compactions: [earlier],
      inputTokenLimit: 20_000,
      messages: turns(3, 10),
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(prepared.messages[0]).toEqual({ content: 'question 1', role: 'user' });
    expect(prepared.note).toBe('[Earlier conversation compacted]\nEarlier summary.');
  });

  it('counts an inline image attachment as its label, not its bytes', async () => {
    const commit = vi.fn(async () => undefined);
    const messages = turns(3, 10);
    messages[0] = {
      content: [
        { text: 'question 0', type: 'text' },
        { image: 'A'.repeat(200_000), mediaType: 'image/png', type: 'image' },
      ],
      role: 'user',
    };
    const prepared = await prepareCompactedContext({
      chain: chain(3),
      commit,
      compactions: [],
      inputTokenLimit: 20_000,
      messages,
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(prepared.messages).toHaveLength(6);
  });

  it('refuses a branch whose messages do not open each turn with one user message', async () => {
    await expect(
      prepareCompactedContext({
        chain: chain(2),
        commit: async () => undefined,
        compactions: [],
        inputTokenLimit: 20_000,
        messages: turns(1, 10),
        signal: new AbortController().signal,
        summarize: async () => summary,
      })
    ).rejects.toThrow('one user message per turn');
  });
});

/**
 * Memory's request over a branch: the earlier turns it holds (by index), the
 * current turn, and its system context. Its rebuild leaves out each turn a
 * committed compaction covers.
 */
function memoryHolding(branch: readonly ModelMessage[], held: readonly number[], system?: string) {
  const compacted = new Set<string>();
  const rebuilds: string[][] = [];
  const step = (runs: readonly number[]): HostPreparedStep => ({
    historyRunIds: new Set(runs.map((index) => `run-${index}`)),
    messages: [
      ...runs.flatMap((index) => branch.slice(index * 2, index * 2 + 2)),
      ...branch.slice(-2),
    ],
    rebuild: async () => {
      const remaining = runs.filter((index) => !compacted.has(`run-${index}`));
      rebuilds.push(remaining.map((index) => `run-${index}`));
      return step(remaining);
    },
    ...(system === undefined ? {} : { system }),
  });
  const prepare = vi.fn(async (_messages: readonly ModelMessage[]) => step(held));
  const committed: Compacted[] = [];
  const commit = async (event: Compacted) => {
    committed.push(event);
    for (const runId of event.compactedRunIds) {
      compacted.add(runId);
    }
  };
  return { commit, committed, memory: { prepare, rewrites: new Map() }, prepare, rebuilds };
}

describe('prepareCompactedContext with Memory (ADR-0013)', () => {
  it('measures the request Memory builds, so a long branch Memory sends little of is not compacted', async () => {
    const branch = turns(6, 40_000);
    // Memory holds run-4 and the current run-5: 20,012 tokens, under the 36,000 trigger.
    const held = memoryHolding(branch, [4]);
    const summarize = vi.fn(async () => summary);
    const { prepared } = await pastTrigger({
      commit: held.commit,
      memory: held.memory,
      messages: branch,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(held.committed).toEqual([]);
    expect(held.prepare).toHaveBeenCalledTimes(1);
    expect(held.rebuilds).toEqual([]);
    expect(prepared.step?.historyRunIds).toEqual(new Set(['run-4']));
  });

  it('compacts only the earlier turns Memory’s request holds, then rebuilds that request without them', async () => {
    const branch = turns(6, 40_000);
    // Memory holds run-1 to run-4 and the current run-5 (50,030 tokens); run-0 is outside its window.
    const held = memoryHolding(branch, [1, 2, 3, 4]);
    const summarize = vi.fn(async (_transcript: string) => summary);
    const { prepared } = await pastTrigger({
      commit: held.commit,
      memory: held.memory,
      messages: branch,
      summarize,
    });
    expect(held.committed.map((event) => event.compactedRunIds)).toEqual([
      ['run-1', 'run-2', 'run-3'],
    ]);
    const transcript = summarize.mock.calls[0]?.[0] ?? '';
    expect(transcript).not.toContain('question 0');
    expect(transcript).toContain('question 1');
    expect(held.prepare).toHaveBeenCalledTimes(1);
    expect(held.rebuilds).toEqual([['run-4']]);
    expect(prepared.step?.historyRunIds).toEqual(new Set(['run-4']));
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${summary.text}`);
  });

  it('counts Memory’s system context toward the trigger', async () => {
    const branch = turns(6, 40_000);
    // 30,018 tokens of messages alone stay under the 36,000 trigger; 20,000 of observations pass it.
    const held = memoryHolding(branch, [3, 4], 'o'.repeat(80_000));
    await pastTrigger({ commit: held.commit, memory: held.memory, messages: branch });
    expect(held.committed.map((event) => event.compactedRunIds)).toEqual([['run-3']]);
  });

  it('measures a pruned tool output as the marker the provider request carries', async () => {
    /** run-3 read a 50,007-token file; Core's branch already carries its pruned marker. */
    const readTurn = (value: string): ModelMessage[] => [
      { content: 'question 3', role: 'user' },
      {
        content: [{ input: {}, toolCallId: 'call-read', toolName: 'readFile', type: 'tool-call' }],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'text', value },
            toolCallId: 'call-read',
            toolName: 'readFile',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
    ];
    const branch = turns(6, 40_000);
    branch.splice(6, 2, ...readTurn('[pruned]'));
    const prune = new Map<string, HostProjectionRewrite>([
      [
        'call-read',
        {
          kind: 'prune',
          markerText: '[pruned]',
          supersededByToolCallId: null,
          toolCallId: 'call-read',
        },
      ],
    ]);
    const measure = async (rewrites: ReadonlyMap<string, HostProjectionRewrite>) => {
      const committed: Compacted[] = [];
      // Memory reads run-3 from the committed log, with the file's raw output.
      const step = (runs: readonly string[]): HostPreparedStep => ({
        historyRunIds: new Set(runs),
        messages: [...(runs.length > 0 ? readTurn('y'.repeat(200_000)) : []), ...branch.slice(-2)],
        rebuild: async () => step([]),
      });
      await pastTrigger({
        commit: async (event) => {
          committed.push(event);
        },
        memory: { prepare: async () => step(['run-3']), rewrites },
        messages: branch,
      });
      return committed.map((event) => event.compactedRunIds);
    };
    expect(await measure(prune)).toEqual([]);
    // The same request unpruned is past the trigger: the marker is what keeps it under.
    expect(await measure(new Map())).toEqual([['run-3']]);
  });
});
