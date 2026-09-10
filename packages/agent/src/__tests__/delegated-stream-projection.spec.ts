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
  it('settles an unfinished child exactly once without losing its native message identity', async () => {
    const projection = createDelegatedStreamProjection({
      authorize: async () => undefined,
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
