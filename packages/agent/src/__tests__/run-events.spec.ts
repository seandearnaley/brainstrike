import { describe, expect, it } from 'vitest';
import { sanitizeAssistantRunEventMetadata } from '../run-events';

describe('run event metadata sanitization', () => {
  it('strips unsafe keys after canonical key normalization', () => {
    const sanitized = sanitizeAssistantRunEventMetadata({
      model: 'gpt-5.2',
      apiKey: 'secret',
      'api-key': 'secret',
      bearerCredential: 'secret',
      nested: {
        userSessionId: 'secret',
        output: 'tool output',
        count: 2,
      },
      values: [{ prompt: 'raw prompt' }, 'safe'],
    });

    expect(sanitized).toEqual({
      model: 'gpt-5.2',
      nested: {
        count: 2,
      },
      values: [{}, 'safe'],
    });
  });

  it('drops non-json objects instead of preserving prototypes', () => {
    const sanitized = sanitizeAssistantRunEventMetadata({
      createdAt: new Date('2026-04-24T00:00:00.000Z'),
      matcher: /secret/u,
    });

    expect(sanitized).toEqual({
      createdAt: null,
      matcher: null,
    });
  });
});
