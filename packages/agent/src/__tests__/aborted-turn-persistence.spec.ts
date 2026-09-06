import type { MastraDBMessage, MessageList } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import { describe, expect, it, vi } from 'vitest';
import { createAbortedTurnPersistence } from '../mastra/aborted-turn-persistence';
import type { RuntimeData } from '../types';

const CREATED_AT = new Date('2026-08-21T12:00:00.000Z');

function message(input: Pick<MastraDBMessage, 'content' | 'id' | 'role'>): MastraDBMessage {
  return {
    ...input,
    createdAt: CREATED_AT,
    resourceId: 'resource-abort-test',
    threadId: 'thread-abort-test',
  };
}

describe('aborted turn persistence', () => {
  it('drops pre-final assistant snapshots with no completed renderable work', async () => {
    const savedMessages: MastraDBMessage[][] = [];
    const memory = {
      createThread: vi.fn(),
      getThreadById: vi.fn().mockResolvedValue({ id: 'thread-abort-test' }),
      saveMessages: vi.fn(async ({ messages }: { messages: MastraDBMessage[] }) => {
        savedMessages.push(messages);
        return { messages };
      }),
    } as unknown as MastraMemory;
    const unsavedMessages = [
      message({
        content: { format: 2, parts: [{ text: 'Run the tool.', type: 'text' }] },
        id: 'user-abort-test',
        role: 'user',
      }),
      message({
        content: {
          format: 2,
          parts: [
            { type: 'step-start' },
            {
              toolInvocation: {
                args: { path: 'unfinished.ts' },
                state: 'call',
                toolCallId: 'call-unfinished',
                toolName: 'read_file',
              },
              type: 'tool-invocation',
            },
          ],
        },
        id: 'assistant-empty-after-filter',
        role: 'assistant',
      }),
      message({
        content: {
          format: 2,
          parts: [
            { type: 'step-start' },
            {
              toolInvocation: {
                args: { path: 'complete.ts' },
                result: { text: 'complete' },
                state: 'result',
                toolCallId: 'call-complete',
                toolName: 'read_file',
              },
              type: 'tool-invocation',
            },
          ],
        },
        id: 'assistant-completed',
        role: 'assistant',
      }),
    ];
    const messageList = {
      drainUnsavedMessages: () => unsavedMessages,
    } as unknown as MessageList;

    const persistence = createAbortedTurnPersistence({
      assistantMessageId: 'assistant-abort-test',
      memory,
      runtimeData: {
        memory: {
          resourceId: 'resource-abort-test',
          threadId: 'thread-abort-test',
        },
      } as RuntimeData,
      shouldPersist: () => true,
    });
    await persistence.attachMessageList(messageList);
    await persistence.finalize();

    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0]?.map(({ id }) => id)).toEqual([
      'user-abort-test',
      'assistant-completed',
    ]);
    expect(JSON.stringify(savedMessages[0])).not.toContain('call-unfinished');
    expect(JSON.stringify(savedMessages[0])).toContain('aborted before completion');
  });
});
