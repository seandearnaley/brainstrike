import { expect, it } from 'vitest';
import { processMastraStreamPart } from '../mastra/agent-streaming';
import { createDelegatedStreamProjection } from '../mastra/delegated-stream-projection';
import { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';

function projection() {
  const state = createTurnAttemptLifecycleState(undefined, undefined, undefined);
  const result = createDelegatedStreamProjection({
    authorize: async () => ({ threadId: 'child' }),
    createState: () => state,
    isActiveToolCall: (current, toolCallId) =>
      current.activeToolEvents?.has(toolCallId) === true &&
      !current.terminalToolCallStates.has(toolCallId),
    mapPart: async (part, current, names) => {
      const mapped = await processMastraStreamPart(part, names, current);
      return {
        ...mapped,
        chunks: mapped.chunks.map((chunk) => {
          if (
            chunk.type === 'delegated-conversation-chunk' ||
            chunk.type === 'child-continuation-chunk'
          ) {
            throw new Error('Unexpected pre-scoped child chunk.');
          }
          return chunk;
        }),
      };
    },
    personas: new Map(),
  });
  if (!result) {
    throw new Error('Missing production projection');
  }
  return { result, state };
}

const valid = {
  contents: 'Human input',
  createdAt: '2026-09-12T00:00:00.000Z',
  id: 'signal-id',
  metadata: { brainstrikeChildContinuation: 'receipt-id' },
};

it('emits the accepted child input once through the shared production mapping path', async () => {
  const { result, state } = projection();
  const part = { data: valid, type: 'data-user-message' };
  expect(await result.project(part, new Map())).toEqual([]);
  expect((await processMastraStreamPart(part, new Map(), state)).chunks).toEqual([
    { createdAt: valid.createdAt, id: valid.id, text: valid.contents, type: 'child-user-message' },
  ]);
});

it.each([
  { ...valid, createdAt: 'not-a-timestamp' },
  { ...valid, metadata: { brainstrikeChildContinuation: '' } },
  { ...valid, metadata: { brainstrikeChildContinuation: 17 } },
])('fails visibly in both production paths for malformed continuation input %j', async (data) => {
  const { result, state } = projection();
  const part = { data, type: 'data-user-message' };
  await expect(result.project(part, new Map())).rejects.toThrow(
    'Malformed child continuation user message'
  );
  await expect(processMastraStreamPart(part, new Map(), state)).rejects.toThrow(
    'Malformed child continuation user message'
  );
});

it('projects image-only native continuation input with its original bytes and exact signal identity', async () => {
  const { result, state } = projection();
  const image = {
    data: 'data:image/png;base64,AQID',
    filename: 'evidence.png',
    mediaType: 'image/png',
    type: 'file',
  };
  const part = { data: { ...valid, contents: [image] }, type: 'data-user-message' };
  expect(await result.project(part, new Map())).toEqual([]);
  expect((await processMastraStreamPart(part, new Map(), state)).chunks).toEqual([
    {
      attachments: [image],
      createdAt: valid.createdAt,
      id: valid.id,
      text: '',
      type: 'child-user-message',
    },
  ]);
});
