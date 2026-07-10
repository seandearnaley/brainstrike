import { describe, expect, it } from 'vitest';
import {
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
