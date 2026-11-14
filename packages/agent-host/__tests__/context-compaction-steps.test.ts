/**
 * BST-2531: a run's own older steps compact between its steps, a call never
 * parts from its result, and a request trim is committed as a compaction.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  compactionCuts,
  overflowCompaction,
  prepareCompactedContext as prepareContext,
} from '../src/context-compaction.ts';
import { estimateTokens } from '../src/context-size.ts';
import type { HostRunState } from '../src/core-state.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { hostIntakeMessage } from '../src/turn-input.ts';
import { readCompactedContext } from './fixtures/compaction-context.ts';

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

/** A log with nothing to list for any span. */
const EMPTY_LEDGER = { earlierRequests: [], filesEdited: [], toolsLoaded: [] };
const readNothing = async () => EMPTY_LEDGER;

/** Past a 40,000-token budget's trigger, committing what compacts. */
async function pastTrigger(overrides: Partial<Input>) {
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

/**
 * One turn of `steps` steps, each a call that writes `chars` characters and
 * its short result: about chars/4 + 11 estimated tokens a step. `intakeAfter`
 * puts a notice the run took between that step and the next; `tools` names
 * the tool a step calls instead (a skill load, an `askUser`). As Core folds
 * them, each step ends where the next begins.
 */
function longTurn(
  id: string,
  steps: number,
  chars: number,
  intakeAfter?: number,
  tools: Readonly<Record<number, string>> = {}
): { readonly messages: ModelMessage[]; readonly run: HostRunState } {
  const messages: ModelMessage[] = [{ content: `question ${id}`, role: 'user' }];
  const stepEnds = new Map<number, number>();
  for (let step = 0; step < steps; step += 1) {
    if (step > 0) {
      stepEnds.set(step - 1, messages.length - 1);
    }
    const toolCallId = `${id}-call-${step}`;
    const toolName = tools[step] ?? 'write';
    messages.push(
      {
        content: [
          {
            input: { content: 'x'.repeat(chars) },
            toolCallId,
            toolName,
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'text', value: 'ok' },
            toolCallId,
            toolName,
            type: 'tool-result',
          },
        ],
        role: 'tool',
      }
    );
    if (step === intakeAfter) {
      messages.push(hostIntakeMessage('A worker reported back.'));
    }
  }
  return { messages, run: { id, stepEnds } as HostRunState };
}

describe('a long run compacts between steps (BST-2531)', () => {
  // Twelve steps of 4,011 estimated tokens (48,136 with the question) against
  // a 40,000-token budget: past its 36,000 trigger; the target is 28,000.
  const long = () => longTurn('run-0', 12, 16_000);
  const stepCompactions = async (
    turn: ReturnType<typeof longTurn>,
    overrides: Partial<Input> = {}
  ) =>
    pastTrigger({
      chain: [turn.run],
      messages: turn.messages,
      ...overrides,
    });

  it('summarizes the run’s older steps, keeping its question and its newest 20,000 tokens', async () => {
    const turn = long();
    const summarize = vi.fn(async (_context: readonly ModelMessage[]) => summary);
    const readLedger = vi.fn(readNothing);
    const { committed, prepared } = await stepCompactions(turn, { readLedger, summarize });
    expect(committed).toEqual([
      {
        ...EMPTY_LEDGER,
        compactedRunIds: [],
        kind: 'agentic',
        modelId: 'gpt-6-sol',
        reason: 'pre-request',
        runId: 'run-0',
        summary: summary.text,
        through: { runId: 'run-0', stepNumber: 6 },
        type: 'context.compacted',
        usage: receipt.usage,
      },
    ]);
    // BST-2532: the summarizer read the run's next request: the whole turn,
    // its newest steps included.
    expect(summarize.mock.calls[0]?.[0]).toEqual(turn.messages);
    expect(prepared.messages).toEqual([turn.messages[0], ...turn.messages.slice(15)]);
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${summary.text}`);
    // The host's lists cover the steps it replaced; no whole turn, so no request.
    expect(readLedger).toHaveBeenCalledWith({
      kept: new Map(),
      runs: new Set(),
      steps: new Map([['run-0', 6]]),
    });
  });

  it('never cuts between a call and its result', async () => {
    const turn = long();
    // Step 6's call was answered after the step, with step 7.
    turn.run.stepEnds.set(6, 13);
    const { committed, prepared } = await stepCompactions(turn);
    expect(committed[0]?.through).toEqual({ runId: 'run-0', stepNumber: 5 });
    expect(prepared.messages.slice(0, 2)).toEqual([turn.messages[0], turn.messages[13]]);
  });

  it('falls back to dropping only the oldest steps that reach the target when the summarizer fails', async () => {
    const { committed, prepared } = await stepCompactions(long(), {
      summarize: async () => {
        throw new Error('provider unavailable');
      },
    });
    // Reclaiming 20,136 takes six steps.
    expect(committed).toEqual([
      {
        ...EMPTY_LEDGER,
        compactedRunIds: [],
        kind: 'deterministic',
        reason: 'pre-request',
        runId: 'run-0',
        summarizerFailure: { code: 'boundary.internal', correlationId: expect.any(String) },
        summary:
          'Deterministic fallback: dropped 6 earlier steps of this turn (12 messages) after an agentic summarizer failure; no summarization model ran.',
        through: { runId: 'run-0', stepNumber: 5 },
        type: 'context.compacted',
      },
    ]);
    expect(prepared.messages).toHaveLength(13);
  });

  it('applies a committed compaction of steps on every later step without committing again', async () => {
    const turn = long();
    const earlier: Compacted = {
      ...EMPTY_LEDGER,
      compactedRunIds: [],
      kind: 'agentic',
      reason: 'pre-request',
      runId: 'run-0',
      summary: 'Steps so far.',
      through: { runId: 'run-0', stepNumber: 6 },
      type: 'context.compacted',
    };
    const commit = vi.fn(async () => undefined);
    const { prepared } = await stepCompactions(turn, {
      commit,
      compactions: [earlier],
      inputTokenLimit: 200_000,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(prepared.messages).toEqual([turn.messages[0], ...turn.messages.slice(15)]);
    expect(prepared.note).toBe('[Earlier conversation compacted]\nSteps so far.');
  });

  it('summarizes earlier turns and the run’s older steps in one compaction', async () => {
    const earlier = turns(3, 400);
    const turn = longTurn('run-3', 12, 16_000);
    const { committed, prepared } = await pastTrigger({
      chain: [...chain(3), turn.run],
      messages: [...earlier, ...turn.messages],
    });
    // The turn before the current one always stays.
    expect(committed.map(({ compactedRunIds, through }) => ({ compactedRunIds, through }))).toEqual(
      [{ compactedRunIds: ['run-0', 'run-1'], through: { runId: 'run-3', stepNumber: 6 } }]
    );
    expect(prepared.messages).toEqual([
      ...earlier.slice(4),
      turn.messages[0],
      ...turn.messages.slice(15),
    ]);
  });

  it('summarizes nothing when what it could drop reaches neither the target nor one protect window', async () => {
    // Six steps (24,070) against 20,000: the trigger is 18,000, the target
    // 14,000. The protect window keeps steps 1 to 5; step 0 (4,011) is all
    // that could go, short of the 10,070 to reclaim.
    const summarize = vi.fn(async () => summary);
    const turn = longTurn('run-0', 6, 16_000);
    const { committed, prepared } = await stepCompactions(turn, {
      inputTokenLimit: 20_000,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    expect(prepared.messages).toEqual(turn.messages);
    // Overflow recovery is the last resort: it still drops what it can.
    expect(
      await overflowCompaction({
        chain: [turn.run],
        compactions: [],
        inputTokenLimit: 20_000,
        messages: turn.messages,
        readLedger: readNothing,
      })
    ).toMatchObject({ through: { runId: 'run-0', stepNumber: 0 } });
  });

  it('summarizes less than one protect window when that reaches the target', async () => {
    // Eight steps (32,092) against 35,000: the trigger is 31,500, the target
    // 24,500. Steps 0 to 2 (12,033) reach the 7,592 to reclaim.
    const { committed } = await stepCompactions(longTurn('run-0', 8, 16_000), {
      inputTokenLimit: 35_000,
    });
    expect(committed.map((event) => event.through)).toEqual([{ runId: 'run-0', stepNumber: 2 }]);
  });

  /**
   * Sixteen steps (64,180) against a 40,000-token budget: the protect window
   * keeps steps 11 to 15, so the compaction runs through step 10. Step 2
   * loads a skill and step 5 holds an `askUser` answer.
   */
  const protectedRun = () =>
    longTurn('run-0', 16, 16_000, undefined, { 2: 'skill', 5: 'brainstrike_askUser' });
  /** The messages of the run's step `step`: its call, then its result. */
  const stepMessages = (turn: ReturnType<typeof longTurn>, step: number) =>
    turn.messages.slice(1 + step * 2, 3 + step * 2);

  it('keeps a step that loaded a skill or holds an askUser answer word for word, and replaces the steps around it', async () => {
    const turn = protectedRun();
    const summarize = vi.fn(async (_context: readonly ModelMessage[]) => summary);
    const { committed, prepared } = await stepCompactions(turn, { summarize });
    expect(committed.map((event) => event.through)).toEqual([
      { kept: [2, 5], runId: 'run-0', stepNumber: 10 },
    ]);
    // BST-2532: the summarizer reads the run's next request as it stands, kept
    // steps included: leaving them out would change the cached prefix.
    expect(summarize.mock.calls[0]?.[0]).toEqual(turn.messages);
    expect(prepared.messages).toEqual([
      turn.messages[0],
      ...stepMessages(turn, 2),
      ...stepMessages(turn, 5),
      ...turn.messages.slice(23),
    ]);
  });

  it('keeps them when the summarizer fails and the fallback drops the oldest steps', async () => {
    const turn = protectedRun();
    const { committed, prepared } = await stepCompactions(turn, {
      summarize: async () => {
        throw new Error('provider unavailable');
      },
    });
    // Reclaiming 36,180 takes every replaceable step: 0, 1, 3, 4 and 6 to 10.
    expect(committed[0]).toMatchObject({
      kind: 'deterministic',
      summary:
        'Deterministic fallback: dropped 9 earlier steps of this turn (18 messages) after an agentic summarizer failure; no summarization model ran.',
      through: { kept: [2, 5], runId: 'run-0', stepNumber: 10 },
    });
    expect(prepared.messages).toEqual([
      turn.messages[0],
      ...stepMessages(turn, 2),
      ...stepMessages(turn, 5),
      ...turn.messages.slice(23),
    ]);
  });

  it('compacts at the trigger when the provider counts the request as more tokens than the estimate (BST-2541)', async () => {
    // Seventeen steps of 2,011 estimated tokens (34,191 with the question) and 5,600 tokens of
    // instructions against 60,000: the trigger is 54,000, the target 42,000. The provider counted
    // the request before step 16 as 55,370, about 1.5 times the estimate as Anthropic counts
    // read-heavy text, so the next request measures 57,381 and must lose 15,381 of the provider's
    // tokens: 10,666 of the estimate's (57,381 is 39,791 estimated). The protect window keeps
    // steps 7 to 16; steps 0 to 6 (14,077) can go, which a 15,381 reclaim would wait for.
    const compact = (summarize: Input['summarize']) => {
      const turn = longTurn('run-0', 17, 8000);
      turn.run.reportedContext = { step: { after: 33, rewritten: [], tokens: 55_370 } };
      return stepCompactions(turn, {
        inputTokenLimit: 60_000,
        readRequestExtras: async () => ({ instructions: 'i'.repeat(22_400), tools: {} }),
        summarize,
      });
    };
    const summarized = await compact(async () => summary);
    expect(summarized.committed.map(({ kind, through }) => ({ kind, through }))).toEqual([
      { kind: 'agentic', through: { runId: 'run-0', stepNumber: 6 } },
    ]);
    // Without a summary, steps 0 to 5 (12,066) reach the 10,666.
    const dropped = await compact(async () => {
      throw new Error('provider unavailable');
    });
    expect(dropped.committed.map(({ kind, through }) => ({ kind, through }))).toEqual([
      { kind: 'deterministic', through: { runId: 'run-0', stepNumber: 5 } },
    ]);
  });

  it('counts the earlier summary’s note in the request it sizes, so a chars/4 provider reclaims its whole excess (BST-2541)', async () => {
    // Thirty-one steps of 2,011 estimated tokens; an earlier compaction replaced steps 0 to 5
    // with a note of 6,007 tokens, so the request holds the note, the question and steps 6 to
    // 30. The provider counted the request before step 30 at exactly chars/4, so the next one
    // measures what it estimates (56,286), 14,286 over the 42,000 target of a 60,000 budget.
    // That takes steps 6 to 13 (16,088) and leaves about 40,200; left out of the estimate, the
    // note would scale the excess down to 12,761 and drop only steps 6 to 12 (14,077), leaving
    // about 42,200, above the target.
    const turn = longTurn('run-0', 31, 8000);
    const earlier: Compacted = {
      ...EMPTY_LEDGER,
      compactedRunIds: [],
      kind: 'agentic',
      reason: 'pre-request',
      runId: 'run-0',
      summary: 's'.repeat(23_800),
      through: { runId: 'run-0', stepNumber: 5 },
      type: 'context.compacted',
    };
    const sent = (
      await prepareContext({
        chain: [turn.run],
        commit: async () => undefined,
        compactions: [earlier],
        inputTokenLimit: 1_000_000,
        messages: turn.messages,
        readLedger: readNothing,
        signal: new AbortController().signal,
        summarize: async () => summary,
      })
    ).messages;
    // What the provider reported for the request before step 30: it held all but step 30's call and result.
    turn.run.reportedContext = {
      step: { after: 61, rewritten: [], tokens: estimateTokens(sent.slice(0, -2)) },
    };
    const { committed } = await stepCompactions(turn, {
      compactions: [earlier],
      inputTokenLimit: 60_000,
      summarize: async () => {
        throw new Error('provider unavailable');
      },
    });
    expect(estimateTokens(sent)).toBe(56_286);
    expect(committed.map(({ kind, through }) => ({ kind, through }))).toEqual([
      { kind: 'deterministic', through: { runId: 'run-0', stepNumber: 13 } },
    ]);
  });

  it('counts a kept step as nothing to reclaim', async () => {
    // As above, eight steps against 35,000 reclaim with steps 0 to 2; with 0 and 1 loading
    // skills only step 2 (4,011) could go, short of both the 7,592 and one protect window.
    const summarize = vi.fn(async () => summary);
    const { committed } = await stepCompactions(
      longTurn('run-0', 8, 16_000, undefined, { 0: 'skill', 1: 'skill' }),
      { inputTokenLimit: 35_000, summarize }
    );
    expect(committed).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
  });

  /** A compaction of run-0 through `stepNumber` that kept `kept`, with nothing in its lists. */
  const stepCompaction = (stepNumber: number, kept: number[]): Compacted => ({
    ...EMPTY_LEDGER,
    compactedRunIds: [],
    kind: 'agentic',
    reason: 'pre-request',
    runId: 'run-0',
    summary: `Through ${stepNumber}.`,
    through: { kept, runId: 'run-0', stepNumber },
    type: 'context.compacted',
  });

  it('keeps every kept step of a run across its compactions', async () => {
    const turn = protectedRun();
    const { prepared } = await stepCompactions(turn, {
      compactions: [stepCompaction(3, [2]), stepCompaction(10, [5])],
      inputTokenLimit: 200_000,
    });
    expect(prepared.messages).toEqual([
      turn.messages[0],
      ...stepMessages(turn, 2),
      ...stepMessages(turn, 5),
      ...turn.messages.slice(23),
    ]);
  });

  it('names every step its run kept, its own and its earlier summary’s, and lists none of them (BST-2527)', async () => {
    // An earlier compaction through step 3 kept step 2; this one replaces steps 4 to 10 and keeps 5.
    const turn = protectedRun();
    const readLedger = vi.fn(readNothing);
    const { committed, prepared } = await stepCompactions(turn, {
      compactions: [stepCompaction(3, [2])],
      readLedger,
    });
    expect(committed.map((event) => event.through)).toEqual([
      { kept: [2, 5], runId: 'run-0', stepNumber: 10 },
    ]);
    // The host's lists leave out every kept step: each is still in the request.
    expect(readLedger).toHaveBeenCalledWith({
      kept: new Map([['run-0', new Set([2, 5])]]),
      runs: new Set(),
      steps: new Map([['run-0', 10]]),
    });
    // The note reads that one summary, and both kept steps stay word for word.
    expect(prepared.note).toBe('[Earlier conversation compacted]\nGoal: g\nState: s');
    expect(prepared.messages).toEqual([
      turn.messages[0],
      ...stepMessages(turn, 2),
      ...stepMessages(turn, 5),
      ...turn.messages.slice(23),
    ]);
  });

  it('lets overflow recovery drop the run’s oldest steps when no earlier turn is droppable', async () => {
    const turn = long();
    const event = await overflowCompaction({
      chain: [turn.run],
      compactions: [],
      inputTokenLimit: 40_000,
      messages: turn.messages,
      readLedger: readNothing,
    });
    expect(event).toMatchObject({
      compactedRunIds: [],
      reason: 'context-overflow',
      through: { runId: 'run-0', stepNumber: 5 },
    });
  });

  it('belongs only to a branch that holds the run whose steps it summarized', async () => {
    const own = longTurn('run-1', 12, 16_000);
    const compaction: Compacted = {
      ...EMPTY_LEDGER,
      compactedRunIds: ['run-0'],
      kind: 'agentic',
      reason: 'pre-request',
      runId: 'run-1',
      summary: 'The first turn and run-1’s first seven steps.',
      through: { runId: 'run-1', stepNumber: 6 },
      type: 'context.compacted',
    };
    const prepare = (runs: readonly HostRunState[], messages: readonly ModelMessage[]) =>
      prepareCompactedContext({
        chain: [...chain(1), ...runs],
        commit: async () => undefined,
        compactions: [compaction],
        inputTokenLimit: 200_000,
        messages: [...turns(1, 10), ...messages],
        readLedger: readNothing,
        signal: new AbortController().signal,
        summarize: async () => summary,
      });
    const held = await prepare([own.run], own.messages);
    expect(held.messages).toEqual([own.messages[0], ...own.messages.slice(15)]);
    // Two later siblings (a rewind, a regenerated later answer) both hold run-1 and see its cut.
    for (const later of ['run-2a', 'run-2b']) {
      const next = longTurn(later, 1, 10);
      const shared = await prepare([own.run, next.run], [...own.messages, ...next.messages]);
      expect(shared.messages).toEqual([
        own.messages[0],
        ...own.messages.slice(15),
        ...next.messages,
      ]);
    }
    // A regenerated answer to run-1's question is a sibling that never had those steps.
    const sibling = longTurn('run-1b', 2, 10);
    const regenerated = await prepare([sibling.run], sibling.messages);
    expect(regenerated.messages).toEqual([...turns(1, 10), ...sibling.messages]);
    expect(regenerated.note).toBeUndefined();
    const rows = [compaction].map(
      (event, seq) => ({ event, seq, threadId: 'thread' }) as HostLogRow
    );
    expect(compactionCuts(rows, new Set(['run-0', 'run-1'])).steps).toEqual(
      new Map([['run-1', 6]])
    );
    expect(compactionCuts(rows, new Set(['run-0', 'run-1b'])).steps).toEqual(new Map());
  });
});

describe('a request trim is committed as a compaction (BST-2531)', () => {
  /** Three short turns, then a run of six steps that took a notice after its fourth. */
  async function trimmable(compactions: Compacted[] = []) {
    const turn = longTurn('run-3', 6, 400, 3);
    const prepared = await prepareCompactedContext({
      chain: [...chain(3), turn.run],
      commit: async () => undefined,
      compactions,
      inputTokenLimit: 200_000,
      messages: [...turns(3, 400), ...turn.messages],
      readLedger: readNothing,
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    return prepared.trim;
  }

  it('names the turns a trimmed request left out', async () => {
    const trim = await trimmable();
    // The request kept run-3's question, its notice and everything after it.
    expect(await trim(2)).toEqual({
      ...EMPTY_LEDGER,
      compactedRunIds: ['run-0', 'run-1', 'run-2'],
      kind: 'deterministic',
      reason: 'request-trim',
      runId: 'run-3',
      summary:
        'Deterministic fallback: dropped 3 earlier turns (6 messages) after a request over the input budget; no summarization model ran.',
      type: 'context.compacted',
    });
  });

  it('names the steps of the running turn a trim left out with its question', async () => {
    const trim = await trimmable();
    // The request kept only the notice and what followed it. The notice is
    // part of step 3, which the request kept a part of: steps 0 to 2 are named.
    expect(await trim(1)).toMatchObject({
      compactedRunIds: ['run-0', 'run-1', 'run-2'],
      reason: 'request-trim',
      summary:
        'Deterministic fallback: dropped 3 earlier turns and 3 earlier steps of this turn (12 messages) after a request over the input budget; no summarization model ran.',
      through: { runId: 'run-3', stepNumber: 2 },
    });
  });

  it('commits nothing for a request that kept every turn, or left out only what was compacted', async () => {
    const trim = await trimmable();
    expect(await trim(5)).toBeUndefined();
    const compacted = await trimmable([
      {
        ...EMPTY_LEDGER,
        compactedRunIds: ['run-0', 'run-1', 'run-2'],
        kind: 'agentic',
        reason: 'pre-request',
        runId: 'run-3',
        summary: 'Earlier turns.',
        through: { runId: 'run-3', stepNumber: 3 },
        type: 'context.compacted',
      },
    ]);
    expect(await compacted(1)).toBeUndefined();
  });

  it('covers what the branch’s summary covered too, and keeps that summary (BST-2527)', async () => {
    const trim = await trimmable([
      {
        ...EMPTY_LEDGER,
        compactedRunIds: ['run-0', 'run-1'],
        kind: 'agentic',
        reason: 'pre-request',
        runId: 'run-3',
        summary: 'Goal: the first two turns.',
        type: 'context.compacted',
      },
    ]);
    expect(await trim(2)).toMatchObject({
      compactedRunIds: ['run-0', 'run-1', 'run-2'],
      reason: 'request-trim',
      summary:
        'Goal: the first two turns.\n\nDeterministic fallback: dropped 1 earlier turns (2 messages) after a request over the input budget; no summarization model ran.',
    });
  });
});
