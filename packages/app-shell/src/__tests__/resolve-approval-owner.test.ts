import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import type { DelegatedConversationNode, DelegatedInvocation } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { resolveApprovalOwner } from '../resolve-approval-owner';

const first: DelegatedRunIdentity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'root-run',
  parentToolCallId: 'first-call',
  personaId: 'explorer',
};
const second: DelegatedRunIdentity = {
  childRuntimeRunId: 'grandchild-run',
  parentRuntimeRunId: 'child-run',
  parentToolCallId: 'second-call',
  personaId: 'worker',
};
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const childInvocation = {
  ...scope,
  ...first,
  hostRunId: 'host-1',
  parentThreadId: 'root',
  threadId: 'child',
  turnMessageId: 'turn-1',
} satisfies DelegatedInvocation;
const grandchildInvocation = {
  ...scope,
  ...second,
  hostRunId: 'host-2',
  parentThreadId: 'child',
  threadId: 'grandchild',
  turnMessageId: 'turn-2',
} satisfies DelegatedInvocation;
const grandchildNode = {
  ...scope,
  color: 'violet',
  configuration: {},
  createdAt: new Date('2026-09-23'),
  displayName: 'Aster',
  parentThreadId: 'child',
  resourceId: 'grandchild-resource',
  threadId: 'grandchild',
  workspaceRootId: null,
} satisfies DelegatedConversationNode;
const approval = {
  delegation: { path: [first, second], toolCallId: 'leaf-call' },
  runId: 'root-run',
  toolCallId: 'leaf-call',
  toolName: 'writeFile',
};

describe('approval owner identity', () => {
  it('inherits the current panel for an approval without delegation', async () => {
    const getInvocation = vi.fn();
    const get = vi.fn();
    await expect(
      resolveApprovalOwner({ get, getInvocation }, scope, 'root', {
        runId: 'root-run',
        toolCallId: 'root-call',
        toolName: 'writeFile',
      })
    ).resolves.toBeUndefined();
    expect(getInvocation).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves the exact nested child through every persisted edge', async () => {
    const getInvocation = vi.fn(async (_scope, key) =>
      key.parentToolCallId === 'first-call' ? childInvocation : grandchildInvocation
    );
    const get = vi.fn(async () => grandchildNode);
    await expect(
      resolveApprovalOwner({ get, getInvocation }, scope, 'root', approval)
    ).resolves.toEqual({ colorId: 'violet', displayName: 'Aster' });
    expect(getInvocation).toHaveBeenNthCalledWith(1, scope, {
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'first-call',
    });
    expect(getInvocation).toHaveBeenNthCalledWith(2, scope, {
      parentRuntimeRunId: 'child-run',
      parentToolCallId: 'second-call',
    });
    expect(get).toHaveBeenCalledWith({ ...scope, threadId: 'grandchild' }, 'grandchild');
  });

  it('resolves a descendant from its current child panel without borrowing a sibling', async () => {
    const repository = {
      get: async () => grandchildNode,
      getInvocation: async (_scope: unknown, key: { parentToolCallId: string }) =>
        key.parentToolCallId === 'first-call' ? childInvocation : grandchildInvocation,
    };
    await expect(resolveApprovalOwner(repository, scope, 'child', approval)).resolves.toEqual({
      colorId: 'violet',
      displayName: 'Aster',
    });
    await expect(
      resolveApprovalOwner(repository, scope, 'sibling', approval)
    ).resolves.toBeUndefined();
  });

  it('inherits the child panel color for that child’s own approval', async () => {
    const get = vi.fn();
    const getInvocation = vi.fn();
    await expect(
      resolveApprovalOwner({ get, getInvocation }, scope, 'child', {
        runId: 'child-run',
        toolCallId: 'own-call',
        toolName: 'writeFile',
      })
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(getInvocation).not.toHaveBeenCalled();
  });

  it.each([
    { finalStored: grandchildInvocation, firstStored: null, name: 'missing ancestor' },
    {
      finalStored: grandchildInvocation,
      firstStored: { ...childInvocation, parentThreadId: 'sibling' },
      name: 'wrong ancestor parent',
    },
    {
      finalStored: grandchildInvocation,
      firstStored: { ...childInvocation, childRuntimeRunId: 'other-run' },
      name: 'wrong child run',
    },
    {
      finalStored: { ...grandchildInvocation, parentThreadId: 'sibling' },
      firstStored: childInvocation,
      name: 'wrong final parent',
    },
  ])('does not tint an unauthorized path: $name', async ({ firstStored, finalStored }) => {
    const get = vi.fn(async () => grandchildNode);
    const getInvocation = vi.fn(async (_scope, key) =>
      key.parentToolCallId === 'first-call' ? firstStored : finalStored
    );
    await expect(
      resolveApprovalOwner({ get, getInvocation }, scope, 'root', approval)
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a final node whose durable parent does not match the invocation chain', async () => {
    const repository = {
      get: async () => ({ ...grandchildNode, parentThreadId: 'sibling' }),
      getInvocation: async (_scope: unknown, key: { parentToolCallId: string }) =>
        key.parentToolCallId === 'first-call' ? childInvocation : grandchildInvocation,
    };
    await expect(
      resolveApprovalOwner(repository, scope, 'root', approval)
    ).resolves.toBeUndefined();
  });
});
