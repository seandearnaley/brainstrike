import {
  CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
  deriveEffectiveInputBudget,
  fault,
} from '@brainstrike/assistant-contract';
import { jsonSchema, type ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { HostContextSummarySchemaError } from '../src/compaction-summary-call.ts';
import {
  compactionCuts,
  type HostCompactionCuts,
  overflowCompaction,
  prepareCompactedContext as prepareContext,
} from '../src/context-compaction.ts';
import type { HostReportedContext, HostRequestExtras } from '../src/context-size.ts';
import { createHostRunState, HostRunMap, type HostRunState } from '../src/core-state.ts';
import type { HostProjectionRewrite } from '../src/ports.ts';
import { applyProjectionRewrites } from '../src/projection-rewrites.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { foldHostRunEvent, hostRunAncestors, hostRunContext } from '../src/run-branch.ts';
import { compactionNoteText, readCompactedContext } from './fixtures/compaction-context.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Input = Parameters<typeof prepareContext>[0];

/** The prepared context, read as its note's text and the turns after it (BST-2532). */
async function prepareCompactedContext(input: Input) {
  return readCompactedContext(await prepareContext(input));
}

function chain(count: number): HostRunState[] {
  return Array.from(
    { length: count },
    (_, index) => ({ id: `run-${index}`, stepEnds: new Map() }) as HostRunState
  );
}

/** `chain(count)` where `run-<index>` holds what its requests reported. */
function reportedChain(count: number, index: number, report: HostReportedContext): HostRunState[] {
  return chain(count).map((run, at) => (at === index ? { ...run, reportedContext: report } : run));
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

/**
 * The branch as the current run's first request sees it: every earlier turn
 * answered, the current one only asked (`turns(count, chars)` less the last answer).
 */
function opening(count: number, chars: number): ModelMessage[] {
  return turns(count, chars).slice(0, -1);
}

/** A 200K window's input budget, 185,904: it compacts at 90% of it, 167,314. */
const BUDGET_200K = deriveEffectiveInputBudget(200_000);
/** A 1M window's input budget, 945,904: the 200K cap, not its 90%, bounds it. */
const BUDGET_1M = deriveEffectiveInputBudget(1_000_000);
const CAP = CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP;

const receipt = { modelId: 'gpt-6-sol', usage: { inputTokens: 300, outputTokens: 40 } };
const summary = { ...receipt, text: 'Goal: g\nState: s' };

/** A log with nothing to list for any span. */
const EMPTY_LEDGER = { earlierRequests: [], filesEdited: [], toolsLoaded: [] };
const readNothing = async () => EMPTY_LEDGER;

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
    readLedger: readNothing,
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
      readLedger: readNothing,
      signal: new AbortController().signal,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(prepared.messages).toEqual(messages);
    expect(prepared.note).toBeUndefined();
  });

  it('summarizes every unprotected turn past the trigger and commits the summarizer receipt', async () => {
    const summarize = vi.fn(async (_context: readonly ModelMessage[]) => summary);
    const { committed, prepared } = await pastTrigger({ summarize });
    expect(committed).toEqual([
      {
        ...EMPTY_LEDGER,
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
    // BST-2532: the summarizer reads the context the run's next request would
    // carry, its kept turns included; with no summary before it, no note leads it.
    expect(summarize.mock.calls[0]?.[0]).toEqual(turns(6, 40_000));
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
        ...EMPTY_LEDGER,
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
      ...EMPTY_LEDGER,
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
      readLedger: readNothing,
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
      readLedger: readNothing,
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
        readLedger: readNothing,
        signal: new AbortController().signal,
        summarize: async () => summary,
      })
    ).rejects.toThrow('one user message per turn');
  });
});

describe('prepareCompactedContext sizes a thread by what its provider reported (BST-2526)', () => {
  it('compacts a branch whose last step reported 170K input tokens on a 186K budget, though its estimate is under the trigger', async () => {
    // Five answered turns of 10,006 estimated tokens and a question: 50,033, far under 167,314.
    const estimated = await pastTrigger({
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
      messages: opening(6, 40_000),
    });
    expect(estimated.committed).toEqual([]);
    // run-4's last step reported 170,000; its answer (message 9) and run-5's question came after: 180,006.
    const reported = await pastTrigger({
      chain: reportedChain(6, 4, { step: { after: 9, rewritten: [], tokens: 170_000 } }),
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
      messages: opening(6, 40_000),
    });
    // The protect window keeps run-3 to run-5.
    expect(reported.committed.map((event) => event.compactedRunIds)).toEqual([
      ['run-0', 'run-1', 'run-2'],
    ]);
    expect(reported.prepared.messages[0]).toEqual({ content: 'question 3', role: 'user' });
  });

  it('compacts at the 200K cap on a 946K budget and reclaims toward 7/9 of the cap', async () => {
    // Seven answered turns of 20,006 estimated tokens and a question: 140,045, under the cap.
    // run-6's last step reported 190,000; its answer (message 13) and run-7's question came after: 210,006.
    const compact = (compactionTokenCap: number | undefined) =>
      pastTrigger({
        chain: reportedChain(8, 6, { step: { after: 13, rewritten: [], tokens: 190_000 } }),
        ...(compactionTokenCap === undefined ? {} : { compactionTokenCap }),
        inputTokenLimit: BUDGET_1M,
        messages: opening(8, 80_000),
        summarize: async () => {
          throw new Error('provider unavailable');
        },
      });
    // Uncapped, 90% of the budget (851,314) is far off.
    expect((await compact(undefined)).committed).toEqual([]);
    // Toward 155,556 is 54,450: the three oldest turns; 70% of the cap (140,000) would take four.
    const { committed } = await compact(CAP);
    expect(committed.map((event) => [event.kind, event.compactedRunIds])).toEqual([
      ['deterministic', ['run-0', 'run-1', 'run-2']],
    ]);
  });

  it('counts the run’s instructions and tool definitions toward a size nothing reported', async () => {
    // 50,033 estimated against a 63,000 trigger: 8,000 tokens of either alone stays under it.
    const instructions = 'i'.repeat(32_000);
    const tools = {
      lookup: { description: 'd'.repeat(32_000), inputSchema: jsonSchema({ type: 'object' }) },
    };
    const compacted = async (extras: HostRequestExtras) =>
      (
        await pastTrigger({
          inputTokenLimit: 70_000,
          messages: opening(6, 40_000),
          readRequestExtras: async () => extras,
        })
      ).committed.map((event) => event.compactedRunIds);
    expect(await compacted({ instructions, tools: {} })).toEqual([]);
    expect(await compacted({ tools })).toEqual([]);
    expect(await compacted({ instructions, tools })).toEqual([['run-0', 'run-1', 'run-2']]);
  });

  it('never adds instructions or tool definitions to a size the provider reported, which holds them', async () => {
    // 100,000 tokens of instructions would pass the 63,000 trigger on any estimate.
    const readRequestExtras = async (): Promise<HostRequestExtras> => ({
      instructions: 'i'.repeat(400_000),
      tools: {},
    });
    // run-4 reported 40,000; with its answer and run-5's question: 50,006.
    const { committed, prepared } = await pastTrigger({
      chain: reportedChain(6, 4, { step: { after: 9, rewritten: [], tokens: 40_000 } }),
      inputTokenLimit: 70_000,
      messages: opening(6, 40_000),
      readRequestExtras,
    });
    expect(committed).toEqual([]);
    expect(prepared.messages).toHaveLength(11);
  });

  it('sizes a branch no step reported from its latest prepared request’s count', async () => {
    const { committed } = await pastTrigger({
      chain: reportedChain(6, 4, { request: { after: 9, rewritten: [], tokens: 170_000 } }),
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
      messages: opening(6, 40_000),
    });
    expect(committed.map((event) => event.compactedRunIds)).toEqual([['run-0', 'run-1', 'run-2']]);
  });

  it('takes off what a tool-output prune freed after the size was reported', async () => {
    /**
     * run-3 read a 30,000-token file. run-4's last step then reported 205,000,
     * and the file's output was pruned to a marker before run-5's first request.
     */
    const unrewritten = turns(6, 40_000);
    unrewritten.splice(
      6,
      2,
      { content: 'question 3', role: 'user' },
      {
        content: [{ input: {}, toolCallId: 'call-read', toolName: 'readFile', type: 'tool-call' }],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'text', value: 'y'.repeat(120_000) },
            toolCallId: 'call-read',
            toolName: 'readFile',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      }
    );
    const rewrites = new Map<string, HostProjectionRewrite>([
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
    const compacted = async (rewritten: readonly string[]) =>
      (
        await pastTrigger({
          chain: reportedChain(6, 4, { step: { after: 10, rewritten, tokens: 205_000 } }),
          compactionTokenCap: CAP,
          inputTokenLimit: BUDGET_1M,
          messages: applyProjectionRewrites(unrewritten, rewrites),
          rewrites,
          unrewritten,
        })
      ).committed.length;
    // 205,000 less the file's 30,000, plus the 20,009 committed since: under the 200,000 cap.
    expect(await compacted(['call-read'])).toBe(0);
    // Had the report already held the marker, nothing was freed since: 225,009.
    expect(await compacted([])).toBe(1);
  });

  it('commits nothing while the reported size is under both 90% of the budget and the cap', async () => {
    // 150,000 and 10,006 after it: 160,006, under 167,314 and under the 200K cap.
    for (const inputTokenLimit of [BUDGET_200K, BUDGET_1M]) {
      const { committed, prepared } = await pastTrigger({
        chain: reportedChain(6, 4, { step: { after: 9, rewritten: [], tokens: 150_000 } }),
        compactionTokenCap: CAP,
        inputTokenLimit,
        messages: opening(6, 40_000),
      });
      expect(committed).toEqual([]);
      expect(prepared.messages).toEqual(opening(6, 40_000));
      expect(prepared.note).toBeUndefined();
    }
  });
});

/**
 * A thread of `count` runs as Core folds its log: run-<i> asked `question i`;
 * `answer` commits run-<i>'s one step with the usage its provider reported.
 */
function foldedThread(count: number, chars: number) {
  const runs = new HostRunMap();
  for (let index = 0; index < count; index += 1) {
    runs.set(
      `run-${index}`,
      createHostRunState(
        'thread-1',
        `run-${index}`,
        'openai::gpt-6-sol',
        {
          author: 'person',
          parentMessageId: index === 0 ? null : `run-${index - 1}`,
          prompt: `question ${index}`,
          userMessageId: `user-${index}`,
        },
        { categories: new Set(), outsideSandbox: new Set(), tools: new Set() }
      )
    );
  }
  const fold = (event: HostEvent) => foldHostRunEvent(runs, event, undefined);
  const answer = (index: number, usage: Extract<HostEvent, { type: 'model.step' }>['usage']) =>
    fold({
      messages: [
        {
          content: [{ text: `answer ${index} ${'x'.repeat(chars)}`, type: 'text' }],
          role: 'assistant',
        },
      ],
      model: { modelId: 'gpt-6-sol', provider: 'openai' },
      runId: `run-${index}`,
      stepNumber: 0,
      type: 'model.step',
      usage,
    });
  /** The current run's branch and its committed context, as its first request reads them. */
  const branch = () => {
    const run = runs.get(`run-${count - 1}`);
    if (!run) {
      throw new Error('The current run was not folded');
    }
    return { chain: [...hostRunAncestors(runs, run), run], messages: hostRunContext(runs, run) };
  };
  return { answer, branch, fold };
}

describe('the committed log sizes a thread (BST-2526)', () => {
  it('reads the input tokens its latest committed step reported', async () => {
    const thread = foldedThread(6, 40_000);
    for (const index of [0, 1, 2, 3]) {
      thread.answer(index, { inputTokens: 1000 + index, outputTokens: 10_003 });
    }
    thread.answer(4, { inputTokens: 170_000, outputTokens: 10_003 });
    const { committed } = await pastTrigger({
      ...thread.branch(),
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
    });
    expect(committed.map((event) => event.compactedRunIds)).toEqual([['run-0', 'run-1', 'run-2']]);
  });

  it('reads the latest prepared request’s count when the provider reported no input tokens', async () => {
    const thread = foldedThread(6, 40_000);
    for (const index of [0, 1, 2, 3]) {
      thread.answer(index, { outputTokens: 10_003 });
    }
    thread.fold({
      accounting: {
        measurement: 'heuristic',
        promptTokens: 160_000,
        removedMessages: 0,
        toolTokens: 10_000,
        totalTokens: 170_000,
        usedBackstop: false,
      },
      modelId: 'gpt-6-sol',
      provider: 'openai',
      runId: 'run-4',
      type: 'provider.request.prepared',
    });
    thread.answer(4, { outputTokens: 10_003 });
    const { committed } = await pastTrigger({
      ...thread.branch(),
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
    });
    expect(committed.map((event) => event.compactedRunIds)).toEqual([['run-0', 'run-1', 'run-2']]);
  });

  it('remembers which tool outputs were rewritten after a size was reported, until the next report', () => {
    const thread = foldedThread(6, 40_000);
    for (const index of [0, 1, 2, 3]) {
      thread.answer(index, { inputTokens: 1000 + index, outputTokens: 10_003 });
    }
    thread.answer(4, { inputTokens: 205_000, outputTokens: 10_003 });
    thread.fold({
      rewrites: [
        {
          kind: 'prune',
          markerText: '[pruned]',
          supersededByToolCallId: null,
          toolCallId: 'call-read',
        },
      ],
      runId: 'run-5',
      type: 'tool.projection.rewritten',
    });
    expect(thread.branch().chain[4]?.reportedContext?.step).toEqual({
      after: 9,
      rewritten: ['call-read'],
      tokens: 205_000,
    });
    thread.answer(5, { inputTokens: 180_000, outputTokens: 10_003 });
    expect(thread.branch().chain[5]?.reportedContext?.step).toEqual({
      after: 11,
      rewritten: [],
      tokens: 180_000,
    });
  });

  it('no longer reads a size reported before a committed compaction, which it no longer describes', async () => {
    const thread = foldedThread(6, 40_000);
    for (const index of [0, 1, 2, 3]) {
      thread.answer(index, { inputTokens: 1000 + index, outputTokens: 10_003 });
    }
    thread.answer(4, { inputTokens: 170_000, outputTokens: 10_003 });
    // An overflow compaction of run-0 commits before run-5's next attempt.
    const overflow: Compacted = {
      ...EMPTY_LEDGER,
      compactedRunIds: ['run-0'],
      kind: 'deterministic',
      reason: 'context-overflow',
      runId: 'run-5',
      summary: 'Deterministic fallback: dropped 1 earlier turns (2 messages).',
      type: 'context.compacted',
    };
    thread.fold(overflow);
    const { committed, prepared } = await pastTrigger({
      ...thread.branch(),
      compactions: [overflow],
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_200K,
    });
    expect(committed).toEqual([]);
    expect(prepared.messages[0]).toEqual({ content: 'question 1', role: 'user' });
  });
});

describe('overflowCompaction', () => {
  it('drops the oldest droppable turns toward 70% of the budget after a context overflow', async () => {
    // 60,036 estimated; toward 35,000 is 25,036: three turns.
    expect(
      await overflowCompaction({
        chain: chain(6),
        compactions: [],
        inputTokenLimit: 50_000,
        messages: turns(6, 40_000),
        readLedger: readNothing,
      })
    ).toEqual({
      ...EMPTY_LEDGER,
      compactedRunIds: ['run-0', 'run-1', 'run-2'],
      kind: 'deterministic',
      reason: 'context-overflow',
      runId: 'run-5',
      summary:
        'Deterministic fallback: dropped 3 earlier turns (6 messages) after a provider context-overflow error; no summarization model ran.',
      type: 'context.compacted',
    });
  });

  it('drops at least one turn when the estimate is already under the target', async () => {
    const event = await overflowCompaction({
      chain: chain(6),
      compactions: [],
      inputTokenLimit: 200_000,
      messages: turns(6, 40_000),
      readLedger: readNothing,
    });
    expect(event?.compactedRunIds).toEqual(['run-0']);
  });

  it('reclaims from the size the provider reported, toward 7/9 of the cap', async () => {
    // 190,000 and 20,009 after it is 54,453 over 155,556: every droppable turn.
    const event = await overflowCompaction({
      chain: reportedChain(6, 4, { step: { after: 9, rewritten: [], tokens: 190_000 } }),
      compactions: [],
      compactionTokenCap: CAP,
      inputTokenLimit: BUDGET_1M,
      messages: turns(6, 40_000),
      readLedger: readNothing,
    });
    expect(event?.compactedRunIds).toEqual(['run-0', 'run-1', 'run-2', 'run-3']);
  });

  it('claims no recovery without an input budget or a droppable turn', async () => {
    const overflow = (input: Partial<Parameters<typeof overflowCompaction>[0]>) =>
      overflowCompaction({
        chain: chain(6),
        compactions: [],
        inputTokenLimit: 50_000,
        messages: turns(6, 40_000),
        readLedger: readNothing,
        ...input,
      });
    expect(await overflow({ inputTokenLimit: undefined })).toBeUndefined();
    expect(await overflow({ chain: chain(2), messages: turns(2, 40_000) })).toBeUndefined();
  });
});

describe('a compaction belongs to the branch it summarized (BST-2528)', () => {
  /**
   * Committed on a sibling branch: it summarized run-0, run-1 and that
   * branch's own run-9, which this branch never had.
   */
  const sibling: Compacted = {
    ...EMPTY_LEDGER,
    compactedRunIds: ['run-0', 'run-1', 'run-9'],
    kind: 'agentic',
    reason: 'pre-request',
    runId: 'run-10',
    summary: 'On the other branch we renamed the module.',
    type: 'context.compacted',
  };

  it('keeps a branch’s own turns, and tells it nothing of a sibling’s, when a sibling compacted their shared turns', async () => {
    const commit = vi.fn(async () => undefined);
    const prepared = await prepareCompactedContext({
      chain: chain(3),
      commit,
      compactions: [sibling],
      inputTokenLimit: 20_000,
      messages: turns(3, 10),
      readLedger: readNothing,
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(prepared.messages).toEqual(turns(3, 10));
    expect(prepared.note).toBeUndefined();
  });

  it('still applies a compaction whose every turn is on the branch', async () => {
    const own: Compacted = { ...sibling, compactedRunIds: ['run-0', 'run-1'], runId: 'run-2' };
    const prepared = await prepareCompactedContext({
      chain: chain(3),
      commit: async () => undefined,
      compactions: [own, sibling],
      inputTokenLimit: 20_000,
      messages: turns(3, 10),
      readLedger: readNothing,
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    expect(prepared.messages[0]).toEqual({ content: 'question 2', role: 'user' });
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${own.summary}`);
  });

  it('lets overflow recovery drop a turn only a sibling’s compaction covered', async () => {
    const event = await overflowCompaction({
      chain: chain(6),
      compactions: [sibling],
      inputTokenLimit: 40_000,
      messages: turns(6, 40_000),
      readLedger: readNothing,
    });
    expect(event?.compactedRunIds).toContain('run-0');
  });

  it('reads from the log only the compactions of the given branch', () => {
    const rows = [sibling, { ...sibling, compactedRunIds: ['run-0'], runId: 'run-1' }].map(
      (event, seq) => ({ event, seq, threadId: 'thread' }) as HostLogRow
    );
    expect(compactionCuts(rows, new Set(['run-0', 'run-1', 'run-2'])).runs).toEqual(
      new Set(['run-0'])
    );
    // The sibling's compaction reaches the branch that holds the run that made it.
    expect(compactionCuts(rows, new Set(['run-0', 'run-1', 'run-9', 'run-10'])).runs).toEqual(
      new Set(['run-0', 'run-1', 'run-9'])
    );
  });
});

describe('a thread carries one current summary (BST-2527)', () => {
  /** What the log holds for a span, as a stub reads it: each whole turn asked once and edited one file. */
  const ledgerOf = () =>
    vi.fn(async (span: HostCompactionCuts) => ({
      earlierRequests: [...span.runs].map((id) => `asked in ${id}`),
      filesEdited: [...span.runs].map((id) => ({ edits: 1, path: `${id}.ts` })),
      toolsLoaded: ['brainstrike_lspInspect'],
    }));
  const merged = { ...receipt, text: 'Goal: merged' };
  const sixRuns = ['run-0', 'run-1', 'run-2', 'run-3', 'run-4', 'run-5'];

  /**
   * A first compaction covered run-0 to run-3 before run-5's request; two
   * turns later run-7's request is past the trigger again, and run-4 and
   * run-5 are droppable.
   */
  async function twice(summarize: Input['summarize'], readLedger = ledgerOf()) {
    const first = await pastTrigger({ readLedger });
    const second = await pastTrigger({
      chain: chain(8),
      compactions: first.committed,
      messages: turns(8, 40_000),
      readLedger,
      summarize,
    });
    return { first: first.committed, readLedger, second };
  }

  it('merges the previous summary with the newly dropped turns into one that covers both', async () => {
    const summarize = vi.fn(async (_context: readonly ModelMessage[]) => merged);
    const { first, second } = await twice(summarize);
    expect(first.map((event) => event.compactedRunIds)).toEqual([sixRuns.slice(0, 4)]);
    expect(second.committed).toEqual([
      {
        compactedRunIds: sixRuns,
        earlierRequests: sixRuns.map((id) => `asked in ${id}`),
        filesEdited: sixRuns.map((id) => ({ edits: 1, path: `${id}.ts` })),
        kind: 'agentic',
        modelId: 'gpt-6-sol',
        reason: 'pre-request',
        runId: 'run-7',
        summary: 'Goal: merged',
        toolsLoaded: ['brainstrike_lspInspect'],
        type: 'context.compacted',
        usage: receipt.usage,
      },
    ]);
    // BST-2532: the summarizer read the run's next request: the previous
    // summary's note first, then every turn no compaction had covered.
    const context = summarize.mock.calls[0]?.[0] ?? [];
    expect(
      compactionNoteText(context)?.startsWith(
        `[Earlier conversation compacted]\n${summary.text}\n\n`
      )
    ).toBe(true);
    expect(context.slice(1)).toEqual(turns(8, 40_000).slice(8));
  });

  it('puts one summary in the note, with the lists the host wrote from the log', async () => {
    const { second } = await twice(async () => merged);
    expect(second.prepared.note).toBe(
      [
        '[Earlier conversation compacted]',
        'Goal: merged',
        '',
        'Files edited:',
        ...sixRuns.map((id) => `- ${id}.ts (1 edit)`),
        '',
        'Tools loaded:',
        '- brainstrike_lspInspect',
        '',
        'Earlier requests:',
        ...sixRuns.map((id) => `- asked in ${id}`),
      ].join('\n')
    );
    expect(second.prepared.messages[0]).toEqual({ content: 'question 6', role: 'user' });
  });

  it('reads the lists for everything the compaction covers, not only what it newly dropped', async () => {
    const { readLedger } = await twice(async () => merged);
    expect(readLedger.mock.calls.at(-1)?.[0]).toEqual({
      kept: new Map(),
      runs: new Set(sixRuns),
      steps: new Map(),
    });
  });

  it('keeps the host’s lists and the previous summary when the summarizer fails', async () => {
    const { second } = await twice(async () => {
      throw new Error('provider unavailable');
    });
    expect(second.committed).toEqual([
      {
        compactedRunIds: sixRuns,
        earlierRequests: sixRuns.map((id) => `asked in ${id}`),
        filesEdited: sixRuns.map((id) => ({ edits: 1, path: `${id}.ts` })),
        kind: 'deterministic',
        reason: 'pre-request',
        runId: 'run-7',
        summarizerFailure: { code: 'boundary.internal', correlationId: expect.any(String) },
        summary: `${summary.text}\n\nDeterministic fallback: dropped 2 earlier turns (4 messages) after an agentic summarizer failure; no summarization model ran.`,
        toolsLoaded: ['brainstrike_lspInspect'],
        type: 'context.compacted',
      },
    ]);
    expect(
      second.prepared.note?.startsWith(`[Earlier conversation compacted]\n${summary.text}\n\n`)
    ).toBe(true);
  });

  /** Committed by `runId`, covering `compactedRunIds`, with nothing in its lists. */
  const compaction = (runId: string, compactedRunIds: string[], text: string): Compacted => ({
    ...EMPTY_LEDGER,
    compactedRunIds,
    kind: 'agentic',
    reason: 'pre-request',
    runId,
    summary: text,
    type: 'context.compacted',
  });

  it('never gives a sibling branch the summary another branch merged, and merges its own', async () => {
    // Both branches hold run-0 to run-2. The other branch ran run-x after run-2
    // and merged its own summary over run-0 to run-2 and run-x.
    const shared = compaction('run-3', ['run-0', 'run-1'], 'Goal: the shared turns.');
    const other = compaction(
      'run-y',
      ['run-0', 'run-1', 'run-2', 'run-x'],
      'Goal: the other branch.'
    );
    const below = await pastTrigger({
      chain: chain(5),
      compactions: [shared, other],
      inputTokenLimit: 20_000,
      messages: turns(5, 10),
    });
    expect(below.committed).toEqual([]);
    expect(below.prepared.note).toBe('[Earlier conversation compacted]\nGoal: the shared turns.');
    expect(below.prepared.messages[0]).toEqual({ content: 'question 2', role: 'user' });

    const summarize = vi.fn(async (_context: readonly ModelMessage[]) => merged);
    const past = await pastTrigger({ compactions: [shared, other], summarize });
    const context = summarize.mock.calls[0]?.[0] ?? [];
    expect(compactionNoteText(context)).toBe(
      '[Earlier conversation compacted]\nGoal: the shared turns.'
    );
    expect(JSON.stringify(context)).not.toContain('the other branch');
    expect(past.committed.map((event) => event.compactedRunIds)).toEqual([sixRuns.slice(0, 4)]);
  });

  /** This branch's request, below its trigger, with `own` and a later compaction a sibling's run made. */
  const besideSibling = (own: Compacted, sibling: Compacted) =>
    pastTrigger({
      chain: chain(5),
      compactions: [own, sibling],
      inputTokenLimit: 20_000,
      messages: turns(5, 10),
    });

  it.each([
    ['fewer of', ['run-0']],
    ['the same of', ['run-0', 'run-1', 'run-2']],
  ])(
    'reads its own summary when a sibling branch later compacted %s their shared turns',
    async (_, shared) => {
      const own = compaction('run-4', ['run-0', 'run-1', 'run-2'], 'Goal: this branch.');
      const sibling = compaction('run-y', shared, 'Goal: the sibling branch.');
      const { prepared } = await besideSibling(own, sibling);
      expect(prepared.note).toBe('[Earlier conversation compacted]\nGoal: this branch.');
      expect(prepared.messages[0]).toEqual({ content: 'question 3', role: 'user' });
    }
  );

  it('keeps the shared turns a sibling branch compacted and this branch did not', async () => {
    const own = compaction('run-4', ['run-0'], 'Goal: this branch.');
    const sibling = compaction('run-y', ['run-0', 'run-1', 'run-2'], 'Goal: the sibling branch.');
    const { prepared } = await besideSibling(own, sibling);
    expect(prepared.note).toBe('[Earlier conversation compacted]\nGoal: this branch.');
    expect(prepared.messages[0]).toEqual({ content: 'question 1', role: 'user' });
  });
});
