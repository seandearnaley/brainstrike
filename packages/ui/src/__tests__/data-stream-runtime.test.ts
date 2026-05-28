import type { ThreadMessage } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { selectTransportMessagesForMastraMemory } from '../assistant-ui-panel/data-stream-runtime';

function message(id: string, role: ThreadMessage['role']): ThreadMessage {
  return {
    id,
    role,
    content: [{ type: 'text', text: id }],
    createdAt: new Date(0),
    metadata: { custom: {} },
  } as ThreadMessage;
}

describe('selectTransportMessagesForMastraMemory', () => {
  it('keeps the full transport history when Mastra memory is not active', () => {
    const messages = [
      message('old-user', 'user'),
      message('old-assistant', 'assistant'),
      message('new-user', 'user'),
    ];

    expect(selectTransportMessagesForMastraMemory(messages, { data: {} })).toBe(messages);
  });

  it('sends only system context and the current turn when Mastra memory is active', () => {
    const system = message('system', 'system');
    const oldUser = message('old-user', 'user');
    const oldAssistant = message('old-assistant', 'assistant');
    const currentUser = message('new-user', 'user');
    const messages = [system, oldUser, oldAssistant, currentUser];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([system, currentUser]);
  });

  it('keeps trailing active-turn messages after the latest user message', () => {
    const oldUser = message('old-user', 'user');
    const oldAssistant = message('old-assistant', 'assistant');
    const currentUser = message('new-user', 'user');
    const activeAssistant = message('active-assistant', 'assistant');
    const messages = [oldUser, oldAssistant, currentUser, activeAssistant];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([currentUser, activeAssistant]);
  });

  it('keeps the transport payload bounded for long memory-backed threads', () => {
    const system = message('system', 'system');
    const historicalMessages = Array.from({ length: 200 }, (_, index) =>
      message(`history-${index}`, index % 2 === 0 ? 'user' : 'assistant')
    );
    const currentUser = message('current-user', 'user');
    const messages = [system, ...historicalMessages, currentUser];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([system, currentUser]);
  });
});
