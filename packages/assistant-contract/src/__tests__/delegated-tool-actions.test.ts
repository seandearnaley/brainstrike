import { describe, expect, it } from 'vitest';
import { isAssistantToolApprovalAction, isRediscoveredToolApproval } from '../tool-approval.js';
import { isAssistantToolResumeAction, isRediscoveredToolSuspend } from '../tool-suspend.js';

const delegation = {
  path: [
    {
      childRuntimeRunId: 'child',
      parentRuntimeRunId: 'root',
      parentToolCallId: 'delegate-child',
      personaId: 'worker',
    },
    {
      childRuntimeRunId: 'leaf',
      parentRuntimeRunId: 'child',
      parentToolCallId: 'delegate-leaf',
      personaId: 'explore',
    },
  ],
  toolCallId: 'read-1',
};
const approval = {
  action: 'approve',
  delegation,
  runId: 'root',
  toolCallId: 'delegate-child',
};

describe('delegated tool action wire identity', () => {
  it('carries the exact leaf call through both continuation transports', () => {
    expect(isAssistantToolApprovalAction(approval)).toBe(true);
    expect(
      isAssistantToolResumeAction({
        delegation,
        resumeData: { answer: 'Continue' },
        runId: 'root',
        toolCallId: 'delegate-child',
      })
    ).toBe(true);
  });

  it.each([
    { ...delegation, path: [] },
    { ...delegation, toolCallId: '' },
    { ...delegation, toolCallId: 'x'.repeat(513) },
    { ...delegation, extra: true },
    { ...delegation, path: [delegation.path[1], delegation.path[0]] },
    { ...delegation, path: [{ ...delegation.path[0], childRuntimeRunId: 'root' }] },
    { ...delegation, path: [{ ...delegation.path[0], unexpected: true }] },
  ])('rejects malformed or disconnected ancestry (%j)', (invalid) => {
    expect(isAssistantToolApprovalAction({ ...approval, delegation: invalid })).toBe(false);
    expect(
      isAssistantToolResumeAction({
        delegation: invalid,
        resumeData: {},
        runId: 'root',
        toolCallId: 'delegate-child',
      })
    ).toBe(false);
  });

  it('rejects a valid path attached to another parent decision', () => {
    expect(isAssistantToolApprovalAction({ ...approval, runId: 'other-root' })).toBe(false);
    expect(isAssistantToolApprovalAction({ ...approval, toolCallId: 'other-child' })).toBe(false);
  });
});

describe('rediscovered delegated decision identity', () => {
  const notice = {
    delegation,
    runId: 'root',
    stale: false,
    suspendedAt: '2026-09-10T10:00:00.000Z',
    toolCallId: 'delegate-child',
    toolName: 'brainstrike.askUser',
  };
  it.each([isRediscoveredToolApproval, isRediscoveredToolSuspend])(
    'retains valid ancestry and rejects malformed or mismatched parents',
    (validate) => {
      expect(validate(notice)).toBe(true);
      expect(validate({ ...notice, delegation: { ...delegation, path: [] } })).toBe(false);
      expect(validate({ ...notice, runId: 'another-root' })).toBe(false);
      expect(validate({ ...notice, toolCallId: 'another-delegation' })).toBe(false);
    }
  );
});
