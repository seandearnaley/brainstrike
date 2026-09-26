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
      isActiveToolCall: () => false,
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
      isActiveToolCall: () => false,
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
      isActiveToolCall: () => false,
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
      isActiveToolCall: () => false,
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
      isActiveToolCall: () => false,
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
    isActiveToolCall: () => false,
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

it('projects a synthesis part onto its owner child as a delegation.budget.exhausted run event', async () => {
  const projection = createDelegatedStreamProjection({
    authorize: async () => ({ messageId: 'native-message', threadId: 'child' }),
    createState: () => ({}),
    isActiveToolCall: () => false,
    mapPart: async () => ({ chunks: [], finished: false }),
    personas: new Map([['agent-explore', 'explore']]),
  });
  if (!projection) {
    throw new Error('Missing projection');
  }
  const synthesis = {
    data: {
      cap: 'steps',
      limit: 32,
      outputTokens: 512,
      reservedOutputTokens: 2048,
      resourceId: 'child-resource',
      threadId: 'child',
      truncated: true,
      used: 31,
    },
    type: 'data-brainstrike-delegated-synthesis',
  };
  // Nobody published this thread yet.
  await expect(projection.project(synthesis, new Map())).rejects.toThrow(
    'no unique published native child owner'
  );
  await projection.project(part, new Map());
  const chunks = await projection.project(synthesis, new Map());
  expect(chunks).toMatchObject([
    {
      chunk: {
        event: {
          kind: 'delegation.budget.exhausted',
          label: 'Subagent step budget exhausted (31 of 32); summary reserved and truncated',
          metadata: {
            cap: 'steps',
            limit: 32,
            outputTokens: 512,
            parentToolCallId: 'call',
            personaId: 'explore',
            reservedOutputTokens: 2048,
            synthesisForced: true,
            truncated: true,
            used: 31,
          },
          status: 'info',
        },
        type: 'run-event',
      },
      identity,
      messageId: 'native-message',
      type: 'delegated-conversation-chunk',
    },
  ]);
  await expect(
    projection.project(
      { ...synthesis, data: { ...synthesis.data, threadId: 'foreign' } },
      new Map()
    )
  ).rejects.toThrow('no unique published native child owner');
  // A malformed part is a defect, never dropped.
  await expect(
    projection.project({ ...synthesis, data: { ...synthesis.data, cap: 'moon' } }, new Map())
  ).rejects.toThrow();
});

it('attributes only an active child tool’s known custom output to its observed native invocation', async () => {
  const activeCalls = new Map<string, Set<string>>();
  const projection = createDelegatedStreamProjection({
    authorize: async (native) => ({ threadId: `child-${native.parentToolCallId}` }),
    createState: (_persona, _thread, native) => {
      const calls = new Set<string>();
      activeCalls.set(native.parentToolCallId, calls);
      return calls;
    },
    isActiveToolCall: (state, callId) => state.has(callId),
    mapPart: async (candidate, state, names) => {
      const value = candidate as {
        payload?: { toolCallId?: string; toolName?: string };
        type: string;
      };
      if (value.type === 'tool-call' && value.payload?.toolCallId) {
        names.set(value.payload.toolCallId, value.payload.toolName ?? 'unknown');
        state.add(value.payload.toolCallId);
      }
      if (value.type === 'tool-result' && value.payload?.toolCallId) {
        state.delete(value.payload.toolCallId);
      }
      return {
        chunks:
          value.type === 'brainstrike.shell-output.chunk'
            ? [
                {
                  chunk: 'output',
                  stream: 'stdout',
                  toolCallId: 'native-call',
                  type: 'shell-output' as const,
                },
              ]
            : [],
        finished: value.type === 'finish',
      };
    },
    personas: new Map([
      ['agent-explore', 'explore'],
      ['agent-worker', 'worker'],
    ]),
  });
  if (!projection) {
    throw new Error('Missing projection');
  }
  const wrap = (
    output: unknown,
    runId = 'parent-run',
    callId = 'call',
    toolName = 'agent-explore'
  ) => ({
    payload: { output, toolCallId: callId, toolName },
    runId,
    type: 'tool-output',
  });
  const custom = {
    chunk: 'output',
    stream: 'stdout',
    toolCallId: 'native-call',
    type: 'brainstrike.shell-output.chunk',
  };
  await expect(projection.project(wrap(custom), new Map())).rejects.toThrow(
    'no observed active native owner'
  );
  await projection.project(
    wrap({
      messageId: 'observed-message',
      payload: { toolCallId: 'native-call', toolName: 'brainstrike.executeCommand' },
      runId: 'child-run',
      type: 'tool-call',
    }),
    new Map()
  );
  expect(await projection.project(wrap(custom), new Map())).toMatchObject([
    { chunk: { type: 'shell-output' }, identity, messageId: 'observed-message' },
  ]);
  await expect(
    projection.project(wrap(custom, 'parent-run', 'call', 'agent-worker'), new Map())
  ).rejects.toThrow('no observed active native owner');
  expect(
    await projection.project(wrap({ ...custom, messageId: 'observed-message' }), new Map())
  ).toMatchObject([{ messageId: 'observed-message' }]);
  for (const runId of ['', null, 123]) {
    await expect(projection.project(wrap({ ...custom, runId }), new Map())).rejects.toThrow(
      'requires observed native identity'
    );
  }
  await expect(
    projection.project(wrap({ ...custom, messageId: 'foreign-message' }), new Map())
  ).rejects.toThrow('changed its observed message identity');
  await projection.project(
    wrap(
      {
        messageId: 'sibling-message',
        payload: { toolCallId: 'native-call', toolName: 'brainstrike.executeCommand' },
        runId: 'sibling-run',
        type: 'tool-call',
      },
      'parent-run',
      'sibling-call'
    ),
    new Map()
  );
  expect(
    await projection.project(wrap(custom, 'parent-run', 'sibling-call'), new Map())
  ).toMatchObject([
    { identity: { childRuntimeRunId: 'sibling-run', parentToolCallId: 'sibling-call' } },
  ]);
  await expect(
    projection.project(wrap({ ...custom, toolCallId: 'other-call' }), new Map())
  ).rejects.toThrow('no observed active native owner');
  await expect(projection.project(wrap(custom, 'other-parent'), new Map())).rejects.toThrow(
    'no observed active native owner'
  );
  await expect(
    projection.project(wrap(custom, 'parent-run', 'other-delegation'), new Map())
  ).rejects.toThrow('no observed active native owner');
  await expect(
    projection.project(wrap({ payload: { text: 'ordinary part' }, type: 'text-delta' }), new Map())
  ).rejects.toThrow('requires observed native identity');
  await expect(
    projection.project(wrap({ ...custom, runId: 'changed-child' }), new Map())
  ).rejects.toThrow('changed its native invocation identity');
  activeCalls.get('call')?.delete('native-call');
  await expect(projection.project(wrap(custom), new Map())).rejects.toThrow(
    'no observed active native owner'
  );
  activeCalls.get('call')?.add('native-call');
  await projection.project(wrap({ runId: 'child-run', type: 'finish' }), new Map());
  expect(await projection.project(wrap(custom), new Map())).toEqual([]);
  await expect(
    projection.project(wrap(custom, 'parent-run', 'call', 'agent-worker'), new Map())
  ).rejects.toThrow('no observed active native owner');
  await expect(
    projection.project(wrap({ ...custom, toolCallId: 'unknown-after-terminal' }), new Map())
  ).rejects.toThrow('no observed active native owner');
  await expect(
    projection.project(wrap({ ...custom, messageId: 'foreign-after-terminal' }), new Map())
  ).rejects.toThrow('changed its observed message identity');
  await expect(
    projection.project(wrap({ ...custom, runId: 'changed-after-terminal' }), new Map())
  ).rejects.toThrow('changed its native invocation identity');
  expect(
    await projection.project(wrap(custom, 'parent-run', 'sibling-call'), new Map())
  ).toMatchObject([
    { identity: { childRuntimeRunId: 'sibling-run', parentToolCallId: 'sibling-call' } },
  ]);
});
