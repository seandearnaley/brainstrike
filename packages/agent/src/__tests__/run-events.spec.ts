import { describe, expect, it } from 'vitest';
import { sanitizeAssistantRunEventMetadata } from '../run-events';

describe('run event metadata sanitization', () => {
  it('strips unsafe keys after canonical key normalization', () => {
    const sanitized = sanitizeAssistantRunEventMetadata({
      model: 'gpt-5.2',
      promptTokens: 128,
      apiKey: 'secret',
      'api-key': 'secret',
      bearerCredential: 'secret',
      nested: {
        userSessionId: 'secret',
        output: 'tool output',
        count: 2,
      },
      memoryHitCount: 3,
      completionTokens: 64,
      values: [{ prompt: 'raw prompt' }, 'safe'],
    });

    expect(sanitized).toEqual({
      model: 'gpt-5.2',
      promptTokens: 128,
      memoryHitCount: 3,
      completionTokens: 64,
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

  it('bounds recursive metadata sanitization depth', () => {
    const sanitized = sanitizeAssistantRunEventMetadata({
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: {
                    level8: {
                      level9: {
                        level10: 'too deep',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(sanitized).toEqual({
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: {
                    level8: {
                      level9: null,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
