import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  HostContextSummarySchemaError,
  prepareCompactedContext,
} from '../src/context-compaction.js';
import type { HostRunState } from '../src/core-state.js';
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
    expect(committed[0]).toMatchObject({ kind: 'deterministic', ...receipt });
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
