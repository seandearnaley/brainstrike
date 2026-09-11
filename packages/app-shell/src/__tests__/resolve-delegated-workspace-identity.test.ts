import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import type { SuspendedRunDiscovery } from '@brainstrike/assistant-data';
import type { DelegatedConversationRuntimeOptions } from '@brainstrike/assistant-ui';
import type {
  DelegatedConversationNode,
  DelegatedConversationRepository,
  DelegatedInvocation,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedWorkspaceDiscovery } from '../delegated-workspace-discovery';
import {
  resolveDelegatedWorkspaceDecision,
  resolveDelegatedWorkspaceIdentity,
} from '../resolve-delegated-workspace-identity';

const node: DelegatedConversationNode = {
  color: 'emerald',
  configuration: {},
  createdAt: new Date('2026-09-10'),
  displayName: 'Cedar',
  ownerResourceId: 'owner',
  parentThreadId: 'root',
  resourceId: 'native-child',
  rootThreadId: 'root',
  threadId: 'child',
  workspaceRootId: null,
};
const edge: DelegatedRunIdentity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'call',
  personaId: 'explore',
};
const invocation: DelegatedInvocation = {
  ...node,
  ...edge,
  hostRunId: 'host',
  parentThreadId: 'root',
  turnMessageId: 'turn',
};

describe('restored child invocation authority', () => {
  it.each(['approval', 'question'] as const)(
    'resolves a parsed persisted %s action and rejects ordinary input before lookup',
    async (kind) => {
      const target = {
        delegation: { path: [edge], toolCallId: 'leaf' },
        runId: 'parent-run',
        toolCallId: 'call',
      };
      const custom =
        kind === 'approval'
          ? { [TOOL_APPROVAL_RUN_CONFIG_KEY]: { ...target, action: 'approve' } }
          : { [TOOL_SUSPEND_RUN_CONFIG_KEY]: { ...target, resumeData: { answer: 'TypeScript' } } };
      const message: Parameters<DelegatedConversationRuntimeOptions['onNew']>[0] = {
        attachments: [],
        content: [{ text: 'Decision', type: 'text' }],
        createdAt: new Date(),
        metadata: { custom },
        parentId: 'saved-row',
        role: 'user',
        runConfig: { custom },
        sourceId: null,
        startRun: true,
      };
      const getInvocation = vi.fn(async () => invocation);
      await expect(
        resolveDelegatedWorkspaceDecision({ getInvocation }, node, message)
      ).resolves.toEqual(edge);
      expect(getInvocation).toHaveBeenCalledTimes(1);
      await expect(
        resolveDelegatedWorkspaceDecision({ getInvocation }, node, {
          ...message,
          runConfig: { custom: {} },
        })
      ).rejects.toThrow('unambiguous');
      expect(getInvocation).toHaveBeenCalledTimes(1);
    }
  );

  it('discovers root-owned pauses and projects only the selected child while retaining discovery errors', async () => {
    const selected = {
      delegation: { path: [edge], toolCallId: 'write' },
      runId: 'parent-run',
      stale: false,
      suspendedAt: '2026-09-10T00:00:00.000Z',
      toolCallId: 'call',
      toolName: 'write',
    };
    const sibling = {
      ...selected,
      delegation: { path: [{ ...edge, parentToolCallId: 'sibling-call' }], toolCallId: 'write' },
    };
    const discoverRoot = vi.fn<SuspendedRunDiscovery>(async () => ({
      approvals: [selected, sibling],
      error: { reason: 'request-failed' },
      suspends: [],
    }));
    const discover = createDelegatedWorkspaceDiscovery(
      {
        getInvocation: async (_scope, key) =>
          key.parentToolCallId === 'call'
            ? invocation
            : { ...invocation, parentToolCallId: 'sibling-call', threadId: 'sibling' },
      },
      node,
      discoverRoot
    );
    await expect(discover('child', 'native-child')).resolves.toEqual({
      approvals: [selected],
      error: { reason: 'request-failed' },
      suspends: [],
    });
    expect(discoverRoot).toHaveBeenCalledWith('root', 'owner');
  });
  it.each([false, true])(
    'surfaces broken invocation discovery even with an upstream failure (%s)',
    async (upstreamFailure) => {
      const discover = createDelegatedWorkspaceDiscovery(
        { getInvocation: async () => null },
        node,
        async () => ({
          ...(upstreamFailure ? { error: { reason: 'request-failed' as const } } : {}),
          approvals: [
            {
              delegation: { path: [edge], toolCallId: 'write' },
              runId: 'parent-run',
              stale: false,
              suspendedAt: '2026-09-10T00:00:00.000Z',
              toolCallId: 'call',
              toolName: 'write',
            },
          ],
          suspends: [],
        })
      );
      await expect(discover('child', 'native-child')).resolves.toEqual({
        approvals: [],
        error: { reason: 'invalid-response' },
        suspends: [],
      });
    }
  );

  it('resolves the exact selected child in a nested path using persisted invocation bindings', async () => {
    const other = { ...edge, parentToolCallId: 'ancestor-call' };
    const getInvocation = vi.fn(
      async (
        _scope: Parameters<DelegatedConversationRepository['getInvocation']>[0],
        key: Parameters<DelegatedConversationRepository['getInvocation']>[1]
      ) =>
        key.parentToolCallId === 'call'
          ? invocation
          : { ...invocation, parentToolCallId: 'ancestor-call', threadId: 'ancestor' }
    );
    await expect(
      resolveDelegatedWorkspaceIdentity({ getInvocation }, node, [other, edge])
    ).resolves.toEqual(edge);
    expect(getInvocation).toHaveBeenCalledWith(
      { ownerResourceId: 'owner', rootThreadId: 'root' },
      { parentRuntimeRunId: 'parent-run', parentToolCallId: 'call' }
    );
  });
  it('does not borrow an invocation from another same-persona child', async () => {
    await expect(
      resolveDelegatedWorkspaceIdentity(
        { getInvocation: async () => ({ ...invocation, threadId: 'sibling' }) },
        node,
        [edge]
      )
    ).resolves.toBeUndefined();
  });
  it.each([
    null,
    { ...invocation, childRuntimeRunId: 'wrong-run' },
    { ...invocation, personaId: 'wrong-persona' },
    { ...invocation, ownerResourceId: 'other-owner' },
    { ...invocation, rootThreadId: 'other-root' },
  ])('rejects missing or conflicting durable bindings', async (stored) => {
    await expect(
      resolveDelegatedWorkspaceIdentity({ getInvocation: async () => stored }, node, [edge])
    ).rejects.toThrow(/binding/i);
  });
});
