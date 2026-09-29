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
  it('captures Stop before awaiting a native writer and saves that snapshot once', async () => {
    const writer = Promise.withResolvers<void>();
    const snapshot = message({
      content: { format: 2, parts: [{ text: 'Visible at Stop', type: 'text' }] },
      id: 'native-child-message',
      role: 'assistant',
    });
    const saveMessages = vi.fn(async () => ({ messages: [] }));
    const persistence = createAbortedTurnPersistence({
      assistantMessageId: snapshot.id,
      beforePersist: () => writer.promise,
      memory: {
        getThreadById: async () => ({ id: snapshot.threadId }),
        saveMessages,
      } as unknown as MastraMemory,
      runtimeData: { memory: { resourceId: 'resource-abort-test', threadId: 'thread-abort-test' } },
      shouldPersist: () => true,
    });
    await persistence.attachMessageList({
      drainUnsavedMessages: () => [snapshot],
    } as unknown as MessageList);
    persistence.captureSnapshot();
    snapshot.content.parts.push({ text: 'Result before consumer finalization', type: 'text' });
    const finished = persistence.finalize();
    snapshot.content.parts.push({ text: 'Late native result', type: 'text' });
    expect(saveMessages).not.toHaveBeenCalled();
    writer.resolve();
    await finished;
    await persistence.finalize();
    expect(saveMessages).toHaveBeenCalledTimes(1);
    expect(saveMessages).toHaveBeenCalledWith({
      messages: [
        expect.objectContaining({
          content: {
            format: 2,
            parts: [
              { text: 'Visible at Stop', type: 'text' },
              { text: '[Assistant turn aborted before completion.]', type: 'text' },
            ],
          },
          id: 'native-child-message',
        }),
      ],
    });
  });

  it('freezes the JSON storage representation of non-cloneable tool output', async () => {
    const result = { answer: 'Visible evidence', diagnostic: () => 'process-local callback' };
    const snapshot = message({
      content: {
        format: 2,
        parts: [
          {
            toolInvocation: {
              args: {},
              result,
              state: 'result',
              toolCallId: 'done',
              toolName: 'read',
            },
            type: 'tool-invocation',
          },
        ],
      },
      id: 'native-json-message',
      role: 'assistant',
    });
    const saveMessages = vi.fn(async () => ({ messages: [] }));
    const persistence = createAbortedTurnPersistence({
      assistantMessageId: snapshot.id,
      memory: {
        getThreadById: async () => ({ id: snapshot.threadId }),
        saveMessages,
      } as unknown as MastraMemory,
      runtimeData: { memory: { resourceId: 'resource-abort-test', threadId: 'thread-abort-test' } },
      shouldPersist: () => true,
    });
    await persistence.attachMessageList({
      drainUnsavedMessages: () => [snapshot],
    } as unknown as MessageList);
    persistence.captureSnapshot();
    result.answer = 'Late mutation';
    await persistence.finalize();
    expect(saveMessages).toHaveBeenCalledWith({
      messages: [
        expect.objectContaining({
          content: {
            format: 2,
            parts: [
              {
                toolInvocation: {
                  args: {},
                  result: { answer: 'Visible evidence' },
                  state: 'result',
                  toolCallId: 'done',
                  toolName: 'read',
                },
                type: 'tool-invocation',
              },
              { text: '[Assistant turn aborted before completion.]', type: 'text' },
            ],
          },
          id: snapshot.id,
        }),
      ],
    });
  });

  it('still saves the root snapshot when a related child save fails, and reports the failure', async () => {
    const failure = new Error('Child storage rejected the snapshot');
    const saveMessages = vi.fn(async () => ({ messages: [] }));
    const persistence = createAbortedTurnPersistence({
      assistantMessageId: 'native-root-message',
      beforePersist: async () => {
        throw failure;
      },
      memory: {
        getThreadById: async () => ({ id: 'thread-abort-test' }),
        saveMessages,
      } as unknown as MastraMemory,
      runtimeData: { memory: { resourceId: 'resource-abort-test', threadId: 'thread-abort-test' } },
      shouldPersist: () => true,
    });
    await persistence.attachMessageList({
      drainUnsavedMessages: () => [],
    } as unknown as MessageList);
    await expect(persistence.finalize()).rejects.toBe(failure);
    expect(saveMessages).toHaveBeenCalledTimes(1);
  });

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

  it('retains partial text after completed tool work and appends the marker after it (Mastra >= 1.62 cancel persistence)', async () => {
    const savedMessages: MastraDBMessage[][] = [];
    const memory = {
      createThread: vi.fn(),
      getThreadById: vi.fn().mockResolvedValue({ id: 'thread-abort-test' }),
      saveMessages: vi.fn(async ({ messages }: { messages: MastraDBMessage[] }) => {
        savedMessages.push(messages);
        return { messages };
      }),
    } as unknown as MastraMemory;
    const messageList = {
      drainUnsavedMessages: () => [
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
                  args: { path: 'complete.ts' },
                  result: { text: 'complete' },
                  state: 'result',
                  toolCallId: 'call-complete',
                  toolName: 'read_file',
                },
                type: 'tool-invocation',
              },
              { type: 'step-start' },
              { text: 'The answer starts here and', type: 'text' },
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
          id: 'assistant-partial',
          role: 'assistant',
        }),
      ],
    } as unknown as MessageList;

    const persistence = createAbortedTurnPersistence({
      assistantMessageId: 'assistant-abort-test',
      memory,
      runtimeData: {
        memory: { resourceId: 'resource-abort-test', threadId: 'thread-abort-test' },
      } as RuntimeData,
      shouldPersist: () => true,
    });
    await persistence.attachMessageList(messageList);
    await persistence.finalize();

    const assistant = savedMessages[0]?.find((saved) => saved.id === 'assistant-partial');
    const partTypes = assistant?.content.parts.map((part) =>
      part.type === 'text' ? `text:${part.text}` : part.type
    );
    expect(partTypes).toEqual([
      'step-start',
      'tool-invocation',
      'step-start',
      'text:The answer starts here and',
      'text:[Assistant turn aborted before completion.]',
    ]);
    expect(JSON.stringify(savedMessages[0])).not.toContain('call-unfinished');
  });
});
