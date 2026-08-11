import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  buildCompactionOverlayInputProcessor,
  CompactionOverlayProcessor,
} from '../mastra/compaction-overlay-processor';
import type { CompactionRangeEntry } from '../types';

type Message = ProcessInputStepArgs['messages'][number];

function message(id: string, role: 'assistant' | 'system' | 'user' = 'assistant'): Message {
  return {
    content: { format: 2, parts: [{ text: id, type: 'text' }] },
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
    id,
    role,
  } as Message;
}

async function process(
  processor: CompactionOverlayProcessor,
  messages: Message[]
): Promise<readonly Message[]> {
  const result = await processor.processInputStep({
    abort: (reason?: string): never => {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList: {} as ProcessInputStepArgs['messageList'],
    messages,
    model: {} as ProcessInputStepArgs['model'],
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
    systemMessages: [],
  });
  return result?.messages ?? messages;
}

function range(overrides: Partial<CompactionRangeEntry> = {}): CompactionRangeEntry {
  return {
    compactedMessageIds: ['old-1', 'old-3'],
    compactionMessageId: 'summary-1',
    ...overrides,
  };
}

describe('CompactionOverlayProcessor', () => {
  it('is constructed only when lookup capability and thread identity are present', () => {
    const lookup = { listActiveCompactionRanges: async () => [] };
    expect(buildCompactionOverlayInputProcessor(lookup, 'thread-1')?.id).toBe('compaction-overlay');
    expect(buildCompactionOverlayInputProcessor(undefined, 'thread-1')).toBeUndefined();
    expect(buildCompactionOverlayInputProcessor(lookup, undefined)).toBeUndefined();
  });

  it('excises exact compacted ids while preserving protected ids omitted at selection time', async () => {
    const messages = [
      message('old-1'),
      message('old-protected-plan'),
      message('old-3'),
      message('summary-1'),
      message('tail-user', 'user'),
    ];
    const before = structuredClone(messages);
    const filtered = await process(
      new CompactionOverlayProcessor('thread-1', {
        listActiveCompactionRanges: async () => [range()],
      }),
      messages
    );

    expect(messages).toEqual(before);
    expect(filtered.map((item) => item.id)).toEqual([
      'old-protected-plan',
      'summary-1',
      'tail-user',
    ]);
  });

  it('is a no-op when no compaction rows exist', async () => {
    const messages = [message('old-1'), message('summary-1')];
    const filtered = await process(
      new CompactionOverlayProcessor('thread-1', {
        listActiveCompactionRanges: async () => [],
      }),
      messages
    );
    expect(filtered).toBe(messages);
  });

  it('self-heals by skipping a range whose summary message is absent', async () => {
    const messages = [message('old-1'), message('old-3'), message('tail-user', 'user')];
    const filtered = await process(
      new CompactionOverlayProcessor('thread-1', {
        listActiveCompactionRanges: async () => [range()],
      }),
      messages
    );
    expect(filtered).toBe(messages);
    expect(filtered.map((item) => item.id)).toEqual(['old-1', 'old-3', 'tail-user']);
  });
});
