import type { Agent } from '@mastra/core/agent';
import { expect } from 'vitest';
import type { DelegatedConversationBinding } from '../../mastra/delegated-conversation-binding';
import {
  assertDelegatedToolActionPending,
  claimDelegatedToolAction,
} from '../../mastra/delegated-tool-actions';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../../test-fixtures/scripted-agent-model';

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of stream) {
    /* Drain the real native execution. */
  }
}

/** Reuses the native suite's three-level tree and real workflow storage. */
export async function assertStaleDelegatedDecision(
  tree: (options: {
    leafModelOverride: ReturnType<typeof scriptedAgentModel>;
    requireApproval: boolean;
  }) => { parent: Agent; child: Agent; leaf: Agent; effect: () => unknown }
): Promise<void> {
  const leafModelOverride = scriptedAgentModel((options) =>
    hasToolResult(options, 'read')
      ? textParts('Read evidence.')
      : [
          ...toolCallParts('read', 'read-1', {}).slice(0, -1),
          ...toolCallParts('read', 'read-2', {}).slice(1),
        ]
  );
  const { parent, child, leaf, effect } = tree({ leafModelOverride, requireApproval: true });
  const output = await parent.stream('Read', { memory: { resource: 'owner', thread: 'root' } });
  await collect(output.fullStream);
  const childRun = (await child.listSuspendedRuns()).runs[0];
  const leafRun = (await leaf.listSuspendedRuns()).runs[0];
  if (!(childRun?.threadId && childRun.resourceId && leafRun?.threadId && leafRun.resourceId)) {
    throw new Error('Missing native suspended child scopes');
  }
  const path = [
    {
      childRuntimeRunId: childRun.runId,
      parentRuntimeRunId: output.runId,
      parentToolCallId: 'child-1',
      personaId: 'child',
    },
    {
      childRuntimeRunId: leafRun.runId,
      parentRuntimeRunId: childRun.runId,
      parentToolCallId: 'leaf-1',
      personaId: 'leaf',
    },
  ];
  const scopes = [childRun, leafRun].map((run, index) => {
    const identity = path[index];
    if (!(identity && run.resourceId && run.threadId)) {
      throw new Error('Missing native scope');
    }
    return { identity, resourceId: run.resourceId, threadId: run.threadId };
  });
  const binding: DelegatedConversationBinding = {
    inputProcessor: { id: 'unused', processInput: ({ messages }) => messages },
    prepare: () => undefined,
    // Native snapshot validation here; the real host graph verifier has its own PGlite suite.
    resolveToolAction: async () => scopes,
  };
  const action = {
    delegation: { path, toolCallId: 'read-1' },
    runId: output.runId,
    toolCallId: 'child-1',
  };
  await expect(
    assertDelegatedToolActionPending({ action, agent: parent, binding, requiresApproval: true })
  ).resolves.toMatchObject({ toolCallId: 'read-1', toolName: 'read' });
  await expect(
    assertDelegatedToolActionPending({
      action: { ...action, delegation: { path, toolCallId: 'another-call' } },
      agent: parent,
      binding,
      requiresApproval: true,
    })
  ).rejects.toThrow('stale');
  expect(effect).not.toHaveBeenCalled();
  // Another native resume can finish between the initial snapshot read and
  // acquiring host admission. Recheck freshness while holding that admission.
  await expect(
    claimDelegatedToolAction(
      action,
      {
        ...binding,
        claimToolAction: async () => {
          const resumed = await parent.approveToolCall({
            runId: action.runId,
            toolCallId: action.toolCallId,
          });
          await collect(resumed.fullStream);
        },
        finishToolActions: async () => undefined,
        releaseUnexecutedToolAction: async () => undefined,
      },
      { agent: parent, requiresApproval: true }
    )
  ).rejects.toThrow('stale');
  expect(effect).toHaveBeenCalledTimes(1);
  // The outer alias is still pending, but now belongs to read-2. An old
  // root-only approval would resume this different call.
  expect((await parent.listSuspendedRuns()).runs[0]?.toolCalls[0]?.toolCallId).toBe('child-1');
  await expect(
    assertDelegatedToolActionPending({ action, agent: parent, binding, requiresApproval: true })
  ).rejects.toThrow('stale');
  const nextAction = { ...action, delegation: { path, toolCallId: 'read-2' } };
  await expect(
    assertDelegatedToolActionPending({
      action: nextAction,
      agent: parent,
      binding,
      requiresApproval: true,
    })
  ).resolves.toMatchObject({ toolCallId: 'read-2' });
  await collect(
    (await parent.declineToolCall({ runId: action.runId, toolCallId: action.toolCallId }))
      .fullStream
  );
  expect(effect).toHaveBeenCalledTimes(1);
}
