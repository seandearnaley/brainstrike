import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_REQUEST_ENVELOPE_KEYS,
  createAssistantRequestEnvelope,
} from '../request-envelope';

describe('assistant request envelope', () => {
  it('pins the complete Brainstrike wire contract', () => {
    expect(ASSISTANT_REQUEST_ENVELOPE_KEYS).toEqual([
      'data',
      'inputParentMessageId',
      'messages',
      'pausedMessageId',
      'runConfig',
      'unstable_assistantMessageId',
    ]);
  });

  it('preserves explicit root ancestry and the exact paused owner', () => {
    expect(
      createAssistantRequestEnvelope({
        inputParentMessageId: null,
        messages: [],
        pausedMessageId: 'paused-owner',
      })
    ).toEqual({ inputParentMessageId: null, messages: [], pausedMessageId: 'paused-owner' });
    expect(createAssistantRequestEnvelope({ messages: [] })).not.toHaveProperty(
      'inputParentMessageId'
    );
  });

  it('creates only server-consumed fields and omits undefined optionals', () => {
    expect(
      createAssistantRequestEnvelope({
        assistantMessageId: 'assistant-1',
        data: { provider: 'openai' },
        messages: [{ role: 'user', text: 'hello' }],
        runConfig: { custom: { action: 'resume' } },
      })
    ).toEqual({
      data: { provider: 'openai' },
      messages: [{ role: 'user', text: 'hello' }],
      runConfig: { custom: { action: 'resume' } },
      unstable_assistantMessageId: 'assistant-1',
    });

    expect(createAssistantRequestEnvelope({ messages: [] })).toEqual({ messages: [] });
  });
});
