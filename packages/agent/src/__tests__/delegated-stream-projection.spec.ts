import { describe, expect, it } from 'vitest';
import { createDelegatedStreamProjection } from '../mastra/delegated-stream-projection';
import type { ConversationStreamChunk } from '../types';

const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'call',
  personaId: 'explore',
};
const part = {
  payload: {
    output: {
      payload: { messageId: 'native-message', text: 'Partial' },
      runId: 'child-run',
      type: 'text-delta',
    },
    toolCallId: 'call',
    toolName: 'agent-explore',
  },
  runId: 'parent-run',
  type: 'tool-output',
};

describe('delegated stream terminal ownership', () => {
  it('uses the authorized persisted message identity when a resume wrapper has none', async () => {
    const projection = createDelegatedStreamProjection({
      authorize: async () => ({ messageId: 'persisted-message', threadId: 'child-thread' }),
      createState: () => ({}),
      mapPart: async () => ({
        chunks: [
          {
            event: {
              id: 'event',
              kind: 'run.started',
              label: 'Resumed',
              status: 'running',
              timestamp: new Date().toISOString(),
            },
            type: 'run-event',
          } as const,
        ],
        finished: false,
      }),
      personas: new Map([['agent-explore', 'explore']]),
    });
    const resumed = {
      ...part,
      payload: {
        ...part.payload,
        output: { payload: {}, runId: 'child-run', type: 'tool-output' },
      },
    };
    expect(await projection?.project(resumed, new Map())).toMatchObject([
      { identity, messageId: 'persisted-message' },
    ]);
    expect(
      projection?.finalize(() => [
        { type: 'finish', usage: { completionTokens: 0, promptTokens: 0 } },
      ])
    ).toMatchObject([{ messageId: 'persisted-message' }]);
  });
  it('settles an unfinished child exactly once without losing its native message identity', async () => {
    const projection = createDelegatedStreamProjection({
      authorize: async () => ({ threadId: 'child-thread' }),
      createState: () => ({}),
      mapPart: async () => ({
        chunks: [{ type: 'text-delta', value: 'Partial' } as const],
        finished: false,
      }),
      personas: new Map([['agent-explore', 'explore']]),
    });
    expect(projection).toBeDefined();
    await projection?.project(part, new Map());
    const terminal = {
      finishReason: 'error',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 0, promptTokens: 0 },
    } as const satisfies ConversationStreamChunk;
    expect(projection?.finalize(() => [terminal])).toEqual([
      {
        chunk: terminal,
        identity,
        messageId: 'native-message',
        type: 'delegated-conversation-chunk',
      },
    ]);
    expect(projection?.finalize(() => [terminal])).toEqual([]);
  });
});
