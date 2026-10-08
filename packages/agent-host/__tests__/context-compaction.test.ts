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

function turns(count: number, chars: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index): ModelMessage[] => [
    { content: `question ${index}`, role: 'user' },
    {
      content: [{ text: `answer ${index} ${'x'.repeat(chars)}`, type: 'text' }],
      role: 'assistant',
    },
  ]).flat();
}

const summary = { inputTokens: 300, outputTokens: 40, text: 'Goal: g\nState: s' };

/** Six turns of ~1,000 estimated tokens against a 4,000-token budget: past the trigger. */
async function pastTrigger(overrides: Partial<Input> = {}) {
  const committed: Compacted[] = [];
  const prepared = await prepareCompactedContext({
    chain: chain(6),
    commit: async (event) => {
      committed.push(event);
    },
    compactions: [],
    inputTokenLimit: 4000,
    messages: turns(6, 4000),
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

  it('summarizes every turn but the last two past the trigger and returns the note', async () => {
    const summarize = vi.fn(async (_transcript: string) => summary);
    const { committed, prepared } = await pastTrigger({ summarize });
    expect(committed).toEqual([
      {
        compactedRunIds: ['run-0', 'run-1', 'run-2', 'run-3'],
        kind: 'agentic',
        reason: 'pre-request',
        runId: 'run-5',
        summary: summary.text,
        type: 'context.compacted',
        usage: { inputTokens: 300, outputTokens: 40 },
      },
    ]);
    const transcript = summarize.mock.calls[0]?.[0] ?? '';
    expect(transcript.split('\n')).toHaveLength(8);
    expect(transcript).toContain('question 0');
    expect(transcript).not.toContain('question 4');
    expect(prepared.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(prepared.messages[0]).toEqual({ content: 'question 4', role: 'user' });
    expect(prepared.note).toBe(`[Earlier conversation compacted]\n${summary.text}`);
  });

  it('falls back to dropping only the oldest turns that reach the target when the summarizer fails', async () => {
    const { committed, prepared } = await pastTrigger({
      // ~6,040 estimated tokens against 6,000: reaching the 4,200 target takes two turns.
      inputTokenLimit: 6000,
      summarize: async () => {
        throw new Error('provider unavailable');
      },
    });
    expect(committed).toEqual([
      {
        compactedRunIds: ['run-0', 'run-1'],
        kind: 'deterministic',
        reason: 'pre-request',
        runId: 'run-5',
        summary:
          'Deterministic fallback: dropped 2 earlier turns (4 messages) after an agentic summarizer failure; no summarization model ran.',
        type: 'context.compacted',
      },
    ]);
    expect(prepared.messages[0]).toEqual({ content: 'question 2', role: 'user' });
    expect(prepared.note).toContain(committed[0]?.summary);
  });

  it('keeps the usage of a schema-violating summary on the deterministic fallback', async () => {
    const { committed } = await pastTrigger({
      summarize: async () => {
        throw new HostContextSummarySchemaError({ inputTokens: 300, outputTokens: 12 });
      },
    });
    expect(committed[0]).toMatchObject({
      kind: 'deterministic',
      usage: { inputTokens: 300, outputTokens: 12 },
    });
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
