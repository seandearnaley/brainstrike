import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
  isAssistantToolApprovalAction,
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
  readToolApprovalRunConfigAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '../tool-approval';

describe('readToolApprovalRunConfigAction', () => {
  it('returns undefined when runConfig does not carry a tool approval action', () => {
    expect(readToolApprovalRunConfigAction(undefined)).toBeUndefined();
    expect(readToolApprovalRunConfigAction({})).toBeUndefined();
    expect(readToolApprovalRunConfigAction({ custom: {} })).toBeUndefined();
  });

  it('returns the approval action from runConfig.custom', () => {
    const action = {
      action: 'approve',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'workspace.writeFile',
    } as const;

    expect(
      readToolApprovalRunConfigAction({
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: action,
        },
      })
    ).toEqual({ action });
  });

  it('marks present malformed approval actions invalid', () => {
    expect(
      readToolApprovalRunConfigAction({
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            runId: 'run-approval-1',
          },
        },
      })
    ).toEqual({ invalid: true });
  });

  it('rejects approval actions with extra own fields', () => {
    expect(
      readToolApprovalRunConfigAction({
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            injected: true,
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
          },
        },
      })
    ).toEqual({ invalid: true });
  });

  it('rejects an inherited optional tool name', () => {
    const action = Object.assign(Object.create({ toolName: 'workspace.writeFile' }), {
      action: 'approve',
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
    });

    expect(isAssistantToolApprovalAction(action)).toBe(false);
  });

  it('rejects an explicitly undefined optional tool name', () => {
    expect(
      isAssistantToolApprovalAction({
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: undefined,
      })
    ).toBe(false);
  });

  it('accepts identifiers exactly at the shared approval-action limits', () => {
    expect(
      isAssistantToolApprovalAction({
        action: 'decline',
        runId: 'r'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS),
        toolCallId: 'c'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS),
        toolName: 't'.repeat(ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS),
      })
    ).toBe(true);
  });

  it.each([
    ['runId', ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS],
    ['toolCallId', ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS],
    ['toolName', ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS],
  ] as const)('rejects an oversized %s', (field, maxChars) => {
    expect(
      isAssistantToolApprovalAction({
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
        [field]: 'x'.repeat(maxChars + 1),
      })
    ).toBe(false);
  });

  it('rejects a blank optional tool name', () => {
    expect(
      isAssistantToolApprovalAction({
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: '   ',
      })
    ).toBe(false);
  });
});

describe('isRediscoveredToolApproval', () => {
  const base: RediscoveredToolApproval = {
    runId: 'run-1',
    stale: false,
    suspendedAt: '2026-07-09T00:00:00.000Z',
    toolCallId: 'call-1',
    toolName: 'workspace.writeFile',
  };

  it('accepts a fully-formed rediscovered approval', () => {
    expect(isRediscoveredToolApproval(base)).toBe(true);
    expect(
      isRediscoveredToolApproval({
        ...base,
        args: { path: '/tmp/x' },
        policyDecision: 'ask',
        riskCategory: 'edit',
        stale: true,
      })
    ).toBe(true);
  });

  it('rejects an object missing suspendedAt or stale', () => {
    const { suspendedAt: _suspendedAt, ...withoutSuspendedAt } = base;
    const { stale: _stale, ...withoutStale } = base;
    expect(isRediscoveredToolApproval(withoutSuspendedAt)).toBe(false);
    expect(isRediscoveredToolApproval(withoutStale)).toBe(false);
  });

  it('rejects wrong types for suspendedAt/stale and a missing base field', () => {
    expect(isRediscoveredToolApproval({ ...base, suspendedAt: 123 })).toBe(false);
    expect(isRediscoveredToolApproval({ ...base, stale: 'yes' })).toBe(false);
    const { runId: _runId, ...withoutRunId } = base;
    expect(isRediscoveredToolApproval(withoutRunId)).toBe(false);
    expect(isRediscoveredToolApproval(undefined)).toBe(false);
    expect(isRediscoveredToolApproval(null)).toBe(false);
  });
});
