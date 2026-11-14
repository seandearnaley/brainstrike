/**
 * BST-2531: a run's own older steps compact between its steps, a call never
 * parts from its result, and a request trim is committed as a compaction.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  compactionCuts,
  overflowCompaction,
  prepareCompactedContext,
} from '../src/context-compaction.ts';
import type { HostRunState } from '../src/core-state.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { hostIntakeMessage } from '../src/turn-input.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Input = Parameters<typeof prepareCompactedContext>[0];

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
    signal: new AbortController().signal,
    summarize: async () => summary,
    ...overrides,
  });
  return { committed, prepared };
}

/**
 * One turn of `steps` steps, each a call that writes `chars` characters and
 * its short result: about chars/4 + 11 estimated tokens a step. `intakeAfter`
 * puts a notice the run took between that step and the next. As Core folds
 * them, each step ends where the next begins.
 */
function longTurn(
  id: string,
  steps: number,
  chars: number,
  intakeAfter?: number
): { readonly messages: ModelMessage[]; readonly run: HostRunState } {
  const messages: ModelMessage[] = [{ content: `question ${id}`, role: 'user' }];
  const stepEnds = new Map<number, number>();
  for (let step = 0; step < steps; step += 1) {
    if (step > 0) {
      stepEnds.set(step - 1, messages.length - 1);
    }
    const toolCallId = `${id}-call-${step}`;
    messages.push(
      {
        content: [
          {
            input: { content: 'x'.repeat(chars) },
            toolCallId,
            toolName: 'write',
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
            toolName: 'write',
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
    const summarize = vi.fn(async (_transcript: string) => summary);
    const { committed, prepared } = await stepCompactions(turn, { summarize });
    expect(committed).toEqual([
      {
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
    // Steps 0 to 6: a call and its result each.
    const transcript = summarize.mock.calls[0]?.[0] ?? '';
    expect(transcript.split('\n')).toHaveLength(14);
    expect(transcript).toContain('run-0-call-6');
    expect(transcript).not.toContain('run-0-call-7');
    expect(prepared.messages).toEqual([turn.messages[0], ...turn.messages.slice(15)]);
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${summary.text}`);
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

  it('lets overflow recovery drop the run’s oldest steps when no earlier turn is droppable', async () => {
    const turn = long();
    const event = await overflowCompaction({
      chain: [turn.run],
      compactions: [],
      inputTokenLimit: 40_000,
      messages: turn.messages,
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
      signal: new AbortController().signal,
      summarize: async () => summary,
    });
    return prepared.trim;
  }

  it('names the turns a trimmed request left out', async () => {
    const trim = await trimmable();
    // The request kept run-3's question, its notice and everything after it.
    expect(trim(2)).toEqual({
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
    expect(trim(1)).toMatchObject({
      compactedRunIds: ['run-0', 'run-1', 'run-2'],
      reason: 'request-trim',
      summary:
        'Deterministic fallback: dropped 3 earlier turns and 3 earlier steps of this turn (12 messages) after a request over the input budget; no summarization model ran.',
      through: { runId: 'run-3', stepNumber: 2 },
    });
  });

  it('commits nothing for a request that kept every turn, or left out only what was compacted', async () => {
    const trim = await trimmable();
    expect(trim(5)).toBeUndefined();
    const compacted = await trimmable([
      {
        compactedRunIds: ['run-0', 'run-1', 'run-2'],
        kind: 'agentic',
        reason: 'pre-request',
        runId: 'run-3',
        summary: 'Earlier turns.',
        through: { runId: 'run-3', stepNumber: 3 },
        type: 'context.compacted',
      },
    ]);
    expect(compacted(1)).toBeUndefined();
  });
});
