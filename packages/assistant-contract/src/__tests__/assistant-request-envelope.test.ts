import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_REQUEST_ENVELOPE_KEYS,
  createAssistantRequestEnvelope,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '../assistant-request-envelope';

describe('assistant request envelope', () => {
  it('pins the complete Brainstrike wire contract', () => {
    expect(ASSISTANT_REQUEST_ENVELOPE_KEYS).toEqual([
      'data',
      'messages',
      'runConfig',
      'unstable_assistantMessageId',
    ]);
    expect(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES).toBe(4 * 1024 * 1024);
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
