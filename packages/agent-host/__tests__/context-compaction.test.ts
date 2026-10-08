import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { prepareCompactedContext } from '../src/context-compaction.js';
import type { HostRunState } from '../src/core-state.js';
import type { HostEvent } from '../src/protocol.js';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

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

describe('prepareCompactedContext', () => {
  it('commits nothing below the trigger ratio and returns the branch unchanged', async () => {
    const commit = vi.fn(async () => undefined);
    const messages = turns(4, 400);
    const prepared = await prepareCompactedContext({
      chain: chain(4),
      commit,
      compactions: [],
      inputTokenLimit: 20_000,
      messages,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(prepared).toEqual({ messages });
  });

  it('compacts oldest turns past the trigger, never the last two, and returns the note', async () => {
    const committed: Compacted[] = [];
    const prepared = await prepareCompactedContext({
      chain: chain(6),
      commit: async (event) => {
        committed.push(event);
      },
      compactions: [],
      inputTokenLimit: 4000,
      messages: turns(6, 4000),
    });
    expect(committed).toEqual([
      expect.objectContaining({
        compactedRunIds: ['run-0', 'run-1', 'run-2', 'run-3'],
        kind: 'deterministic',
        reason: 'pre-request',
      }),
    ]);
    expect(prepared.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(prepared.messages[0]).toEqual({ content: 'question 4', role: 'user' });
    expect(prepared.note).toContain(committed[0]?.summary);
  });

  it('applies committed compactions without committing again', async () => {
    const commit = vi.fn(async () => undefined);
    const earlier: Compacted = {
      compactedRunIds: ['run-0'],
      kind: 'deterministic',
      reason: 'pre-request',
      summary: 'Earlier summary.',
      type: 'context.compacted',
    };
    const prepared = await prepareCompactedContext({
      chain: chain(3),
      commit,
      compactions: [earlier],
      inputTokenLimit: 20_000,
      messages: turns(3, 10),
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
      })
    ).rejects.toThrow('one user message per turn');
  });
});
