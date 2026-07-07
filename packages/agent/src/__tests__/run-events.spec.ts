import { describe, expect, it, vi } from 'vitest';
import { emitAssistantRunEventSafely, sanitizeAssistantRunEventMetadata } from '../run-events';

describe('run event metadata sanitization', () => {
  it('strips unsafe keys after canonical key normalization', () => {
    const sanitized = sanitizeAssistantRunEventMetadata({
      accessToken: 'secret',
      'api-key': 'secret',
      apiKey: 'secret',
      bearerCredential: 'secret',
      completionTokens: 64,
      memoryHitCount: 3,
      model: 'gpt-5.2',
      nested: {
        count: 2,
        output: 'tool output',
        refreshToken: 'secret',
        userSessionId: 'secret',
      },
      promptTokens: 128,
      values: [{ prompt: 'raw prompt' }, 'safe'],
    });

    expect(sanitized).toEqual({
      completionTokens: 64,
      memoryHitCount: 3,
      model: 'gpt-5.2',
      nested: {
        count: 2,
      },
      promptTokens: 128,
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

describe('run event emission', () => {
  it('emits created run events through the sink without awaiting async settlement', () => {
    let settleSink: (() => void) | undefined;
    const sink = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleSink = resolve;
        })
    );
    const onError = vi.fn();

    emitAssistantRunEventSafely({
      event: {
        kind: 'memory.history.loaded',
        label: 'Conversation history loaded',
        status: 'completed',
      },
      eventSink: sink,
      onError,
      runId: 'run-1',
    });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'memory.history.loaded',
        label: 'Conversation history loaded',
        runId: 'run-1',
        status: 'completed',
      })
    );
    expect(onError).not.toHaveBeenCalled();
    settleSink?.();
  });

  it('captures synchronous sink failures without throwing', () => {
    const sink = vi.fn(() => {
      throw new Error('sink failed');
    });
    const onError = vi.fn();

    expect(() =>
      emitAssistantRunEventSafely({
        event: {
          kind: 'memory.working.loaded',
          label: 'Working memory loaded',
          status: 'completed',
        },
        eventSink: sink,
        onError,
        runId: 'run-1',
      })
    ).not.toThrow();

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ kind: 'memory.working.loaded', runId: 'run-1' })
    );
  });
});
