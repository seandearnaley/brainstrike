// @vitest-environment node
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import type { DelegatedConversationRuntimeOptions } from '@brainstrike/assistant-ui';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedDecisionDispatcher } from '../delegated-decision-dispatcher';

const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'root-run',
  parentToolCallId: 'child-call',
  personaId: 'explore',
};
const target = {
  delegation: { path: [identity], toolCallId: 'write' },
  runId: 'root-run',
  toolCallId: 'child-call',
};
function message(
  custom: Record<string, unknown>
): Parameters<DelegatedConversationRuntimeOptions['onNew']>[0] {
  return {
    attachments: [],
    content: [{ text: 'Approved the delegated action.', type: 'text' }],
    createdAt: new Date(),
    metadata: { custom },
    parentId: 'child-transcript-head',
    role: 'user',
    runConfig: { custom },
    sourceId: 'child-source',
    startRun: true,
  };
}

describe('delegated decisions reach the owning root', () => {
  it.each([
    { [TOOL_APPROVAL_RUN_CONFIG_KEY]: { ...target, action: 'approve' } },
    { [TOOL_SUSPEND_RUN_CONFIG_KEY]: { ...target, resumeData: { answer: 'Use TypeScript' } } },
  ])(
    'keeps the native decision and echo while letting the root own message topology',
    async (custom) => {
      const appendRoot = vi.fn();
      const send = createDelegatedDecisionDispatcher(identity, appendRoot);
      await send(message(custom));
      expect(appendRoot).toHaveBeenCalledTimes(1);
      expect(appendRoot.mock.calls[0]?.[0]).toMatchObject({
        metadata: { custom },
        role: 'user',
        runConfig: { custom },
        startRun: true,
      });
      expect(appendRoot.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
      expect(appendRoot.mock.calls[0]?.[0]).not.toHaveProperty('sourceId');
    }
  );

  it('rejects ordinary prompts and decisions belonging to a sibling before contacting the root', async () => {
    const appendRoot = vi.fn();
    const send = createDelegatedDecisionDispatcher(identity, appendRoot);
    await expect(send(message({}))).rejects.toThrow();
    await expect(
      send(
        message({
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            ...target,
            action: 'approve',
            delegation: {
              ...target.delegation,
              path: [{ ...identity, childRuntimeRunId: 'sibling' }],
            },
          },
        })
      )
    ).rejects.toThrow();
    expect(appendRoot).not.toHaveBeenCalled();
  });
});
