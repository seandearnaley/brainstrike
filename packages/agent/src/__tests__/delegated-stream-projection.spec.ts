import { describe, expect, it, vi } from 'vitest';
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
  it('emits the history baseline once even when the first renderable chunk is abnormal termination', async () => {
    const baseline = { hostRunId: 'host', messages: [], runEvents: [], threadId: 'child' };
    const projection = createDelegatedStreamProjection({
      authorize: async () => ({ baseline, threadId: 'child' }),
      createState: () => ({}),
      mapPart: async () => ({ chunks: [], finished: false }),
      personas: new Map([['agent-explore', 'explore']]),
    });
    if (!projection) {
      throw new Error('Missing projection');
    }
    expect(await projection.project(part, new Map())).toEqual([]);
    const terminal = projection.finalize(() => [{ type: 'text-delta', value: 'Interrupted' }]);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ baseline });
    expect(
      projection.finalize(() => [{ type: 'text-delta', value: 'Duplicate terminal' }])
    ).toEqual([]);
  });

  it('binds child and parent approval cards to the same exact leaf across reused aliases', async () => {
    const child = { ...identity, personaId: 'child' };
    const leaf = {
      childRuntimeRunId: 'leaf-run',
      parentRuntimeRunId: 'child-run',
      parentToolCallId: 'leaf-call',
      personaId: 'leaf',
    };
    const forward = (edge: typeof identity, output: unknown) => ({
      payload: { output, toolCallId: edge.parentToolCallId, toolName: `agent-${edge.personaId}` },
      runId: edge.parentRuntimeRunId,
      type: 'tool-output',
    });
    const approval = (runId: string, toolCallId: string) => ({
      args: {},
      runId,
      toolCallId,
      toolName: 'read',
      type: 'tool-approval-required' as const,
    });
    const projection = createDelegatedStreamProjection({
      authorize: async () => ({ messageId: 'saved-native-message', threadId: 'owned-thread' }),
      createState: () => ({}),
      mapPart: async (value) => {
        const chunk = value as ReturnType<typeof approval>;
        return { chunks: chunk.type === 'tool-approval-required' ? [chunk] : [], finished: false };
      },
      personas: new Map([
        ['agent-child', 'child'],
        ['agent-leaf', 'leaf'],
      ]),
    });
    if (!projection) {
      throw new Error('Missing projection');
    }
    const first = await projection.project(
      forward(child, forward(leaf, approval('leaf-run', 'read-1'))),
      new Map()
    );
    expect(first[0]?.chunk).toMatchObject({
      delegation: { path: [child, leaf], toolCallId: 'read-1' },
    });
    const parentNotice = projection.decorate(approval('parent-run', 'call'));
    expect(parentNotice).toMatchObject({
      delegation: { path: [child, leaf], toolCallId: 'read-1' },
    });
    const childNotice = await projection.project(
      forward(child, approval('child-run', 'leaf-call')),
      new Map()
    );
    expect(childNotice[0]?.chunk).toMatchObject({
      delegation: { path: [child, leaf], toolCallId: 'read-1' },
    });
    await projection.project(
      forward(child, forward(leaf, approval('leaf-run', 'read-2'))),
      new Map()
    );
    expect(projection.decorate(approval('parent-run', 'call'))).toMatchObject({
      delegation: { toolCallId: 'read-2' },
    });
    expect(parentNotice).toMatchObject({ delegation: { toolCallId: 'read-1' } });
  });

  it('reopens a child that finished on a PAUSE when its resumed continuation re-enters, never one that completed', async () => {
    // A live decision resumes a parked child in-process under the same
    // invocation; the projection dropped its continuation as late parts of a
    // finished child and its usage then had no active owner (2026-09-14).
    const forward = (output: unknown) => ({
      payload: { output, toolCallId: identity.parentToolCallId, toolName: 'agent-explore' },
      runId: identity.parentRuntimeRunId,
      type: 'tool-output',
    });
    const nested = (type: string) => ({ runId: identity.childRuntimeRunId, type });
    const projection = createDelegatedStreamProjection({
      authorize: async () => ({ messageId: 'saved', threadId: 'child' }),
      createState: () => ({}),
      mapPart: async (value) => {
        const { type } = value as { type: string };
        if (type === 'tool-call-approval' || type === 'finish') {
          return {
            chunks: [
              {
                finishReason: type === 'finish' ? 'stop' : 'tool-calls',
                path: [],
                type: 'message-finish',
                usage: { completionTokens: 0, promptTokens: 0 },
              } satisfies ConversationStreamChunk,
            ],
            finished: true,
          };
        }
        return { chunks: [{ type: 'text-delta', value: type }], finished: false };
      },
      personas: new Map([['agent-explore', 'explore']]),
    });
    if (!projection) {
      throw new Error('Missing projection');
    }
    expect(await projection.project(forward(nested('text-delta')), new Map())).toHaveLength(1);
    expect(await projection.project(forward(nested('tool-call-approval')), new Map())).toHaveLength(
      1
    );
    // Parked: the resumed continuation reopens the same child.
    const resumed = await projection.project(forward(nested('text-delta')), new Map());
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.chunk).toEqual({ type: 'text-delta', value: 'text-delta' });
    expect(await projection.project(forward(nested('finish')), new Map())).toHaveLength(1);
    // Completed: a late part stays dropped.
    expect(await projection.project(forward(nested('text-delta')), new Map())).toEqual([]);
  });

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

it('requires exactly one published native child for unwrapped processor usage data', async () => {
  const onUsage = vi.fn();
  const projection = createDelegatedStreamProjection({
    authorize: async () => ({ threadId: 'child' }),
    createState: () => ({}),
    mapPart: async () => ({ chunks: [], finished: false }),
    onUsage,
    personas: new Map([['agent-explore', 'explore']]),
  });
  if (!projection) {
    throw new Error('Missing projection');
  }
  const usage = {
    data: { inputTokens: 2, outputTokens: 3, resourceId: 'child-resource', threadId: 'child' },
    type: 'data-brainstrike-delegated-step-usage',
  };
  await expect(projection.project(usage, new Map())).rejects.toThrow('unique published');
  await projection.project(part, new Map());
  await projection.project(usage, new Map());
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({
    delegation: {
      parentRuntimeRunId: 'parent-run',
      parentToolCallId: 'call',
      resourceId: 'child-resource',
      threadId: 'child',
    },
    inputTokens: 2,
    outputTokens: 3,
    personaId: 'explore',
  });
  await expect(
    projection.project({ ...usage, data: { ...usage.data, threadId: 'foreign' } }, new Map())
  ).rejects.toThrow('unique published');
  await expect(
    projection.project({ ...usage, data: { ...usage.data, inputTokens: -1 } }, new Map())
  ).rejects.toThrow();
  await projection.project(
    {
      ...part,
      payload: {
        ...part.payload,
        output: { ...part.payload.output, runId: 'other-child-run' },
        toolCallId: 'other-call',
      },
    },
    new Map()
  );
  await expect(projection.project(usage, new Map())).rejects.toThrow('unique published');
  expect(onUsage).toHaveBeenCalledTimes(1);
});
