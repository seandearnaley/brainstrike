import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
} from '../assistant-memory-repository';

describe('createAssistantThreadHistoryAdapter', () => {
  it('hydrates assistant-ui history from Mastra memory messages', async () => {
    const repository: AssistantThreadRepository = {
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Remember the deploy window is Friday.' },
          createdAt: new Date('2026-04-22T10:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: { content: 'I will remember that.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
        },
      ]),
    };

    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(repository.listMessages).toHaveBeenCalledWith('thread-1', 'workspace-a');
    expect(history.headId).toBe('message-2');
    expect(history.messages.map((item) => item.parentId)).toEqual([null, 'message-1']);
    expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-2']);
    expect(history.messages[0]?.message.content).toEqual([
      { type: 'text', text: 'Remember the deploy window is Friday.' },
    ]);
  });

  it('does not write client-side history because Mastra is the durable writer', async () => {
    const repository: AssistantThreadRepository = {
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listMessages: vi.fn(async () => []),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await expect(
      adapter.append({
        parentId: null,
        message: {
          id: 'message-1',
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
          attachments: [],
          createdAt: new Date('2026-04-22T10:00:00Z'),
          metadata: { custom: {} },
        },
      })
    ).resolves.toBeUndefined();
    expect(repository.listMessages).not.toHaveBeenCalled();
  });
});
