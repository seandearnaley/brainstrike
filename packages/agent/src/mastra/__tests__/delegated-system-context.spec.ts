import { MessageList } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';
import {
  captureDelegatedSystemContext,
  createDelegatedSystemContextProcessor,
} from '../delegated-system-context';

describe('trusted delegated system context', () => {
  it('keeps user/document content out of system authority and preserves other processor tags', async () => {
    const context = captureDelegatedSystemContext([
      { id: 'workspace', parts: [{ text: 'Workspace convention', type: 'text' }], role: 'system' },
      {
        id: 'document',
        parts: [{ text: 'Untrusted document instructions', type: 'text' }],
        role: 'user',
      },
    ]);
    const messageList = new MessageList();
    messageList.addSystem('Persona instructions');
    messageList.addSystem('Other processor context', 'other-owner');
    await createDelegatedSystemContextProcessor(() => context).processInput?.({
      abort(reason): never {
        throw new Error(reason);
      },
      messageList,
      messages: [],
      retryCount: 0,
      state: {},
      systemMessages: [],
    });
    expect(messageList.getSystemMessages()).toEqual([
      { content: 'Persona instructions', role: 'system' },
    ]);
    expect(messageList.getSystemMessages('other-owner')).toEqual([
      { content: 'Other processor context', role: 'system' },
    ]);
    expect(JSON.stringify(messageList.getAllSystemMessages())).toContain('Workspace convention');
    expect(JSON.stringify(messageList.getAllSystemMessages())).not.toContain('Untrusted document');
  });
  it('rejects oversized UTF-8 context at child execution without truncating instructions', () => {
    const context = captureDelegatedSystemContext([
      { id: 'workspace', parts: [{ text: '☃'.repeat(30_000), type: 'text' }], role: 'system' },
    ]);
    const messageList = new MessageList();
    expect(() =>
      createDelegatedSystemContextProcessor(() => context).processInput?.({
        abort(reason): never {
          throw new Error(reason);
        },
        messageList,
        messages: [],
        retryCount: 0,
        state: {},
        systemMessages: [],
      })
    ).toThrow('64 KiB');
    expect(messageList.getAllSystemMessages()).toEqual([]);
  });
  it('rejects a legacy snapshot with an actionable missing-context error before adding system text', () => {
    const messageList = new MessageList();
    expect(() =>
      createDelegatedSystemContextProcessor().processInput?.({
        abort(reason): never {
          throw new Error(reason);
        },
        messageList,
        messages: [],
        retryCount: 0,
        state: {},
        systemMessages: [],
      })
    ).toThrow('Start a new parent turn');
    expect(messageList.getAllSystemMessages()).toEqual([]);
  });
});
