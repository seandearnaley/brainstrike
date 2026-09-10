import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
  DECLINED_TOOL_RESULT_KIND,
  isAssistantToolApprovalAction,
  isCodeExecutionApprovalContext,
  isDeclinedToolCallResult,
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

  it('validates durable delegated decision state without treating unknown states as pending', () => {
    const delegation = {
      path: [
        {
          childRuntimeRunId: 'child',
          parentRuntimeRunId: base.runId,
          parentToolCallId: base.toolCallId,
          personaId: 'worker',
        },
      ],
      toolCallId: 'leaf',
    };
    for (const decisionState of ['claimed', 'consumed', 'interrupted']) {
      expect(isRediscoveredToolApproval({ ...base, decisionState, delegation })).toBe(true);
      expect(isRediscoveredToolApproval({ ...base, decisionState })).toBe(false);
    }
    expect(isRediscoveredToolApproval({ ...base, decisionState: 'unknown', delegation })).toBe(
      false
    );
    expect(
      isRediscoveredToolApproval(
        Object.assign(Object.create({ decisionState: 'claimed' }), { ...base, delegation })
      )
    ).toBe(false);
  });

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

describe('isCodeExecutionApprovalContext', () => {
  const base = {
    allowedDomains: [],
    allowRead: [],
    allowWrite: ['/tmp/brainstrike-run-python'],
    defaultReadAccess: 'permissive',
    executorKind: 'fence',
    language: 'python',
    policyFingerprint: 'ab12cd34',
    scratchParentDir: '/tmp',
    timeoutMs: 30_000,
  } as const;

  it('accepts a fully-formed execution context', () => {
    expect(isCodeExecutionApprovalContext(base)).toBe(true);
    expect(
      isCodeExecutionApprovalContext({
        ...base,
        allowedDomains: ['pypi.org', '*.githubusercontent.com'],
        defaultReadAccess: 'none',
        executorKind: 'vm',
      })
    ).toBe(true);
  });

  it('rejects a missing or wrong-typed field (every field is load-bearing on a security card)', () => {
    for (const key of Object.keys(base)) {
      const { [key as keyof typeof base]: _dropped, ...withoutKey } = base;
      expect(isCodeExecutionApprovalContext(withoutKey)).toBe(false);
    }
    expect(isCodeExecutionApprovalContext({ ...base, allowedDomains: 'pypi.org' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, allowedDomains: [42] })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, allowWrite: [''] })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, defaultReadAccess: 'maybe' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, executorKind: 'shell' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, language: 'perl' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, policyFingerprint: '' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, scratchParentDir: '' })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, timeoutMs: 0 })).toBe(false);
    expect(isCodeExecutionApprovalContext({ ...base, timeoutMs: 1.5 })).toBe(false);
  });

  it('rejects unknown own keys — the wire shape is exact, matching the approval-action discipline', () => {
    expect(isCodeExecutionApprovalContext({ ...base, injected: true })).toBe(false);
  });

  it('rejects non-records', () => {
    expect(isCodeExecutionApprovalContext(undefined)).toBe(false);
    expect(isCodeExecutionApprovalContext(null)).toBe(false);
    expect(isCodeExecutionApprovalContext('context')).toBe(false);
    expect(isCodeExecutionApprovalContext([base])).toBe(false);
  });
});

describe('isDeclinedToolCallResult', () => {
  const declined = {
    kind: DECLINED_TOOL_RESULT_KIND,
    message: 'The user declined this tool call, so it was not executed.',
  };

  it('accepts the decline envelope, with or without the user reason', () => {
    expect(isDeclinedToolCallResult(declined)).toBe(true);
    expect(isDeclinedToolCallResult({ ...declined, reason: 'not this path' })).toBe(true);
  });

  it('tolerates unknown extra keys — a settled result is display data', () => {
    // The run_python surface narrows the SAME value through its own union, so
    // additive evolution on either side must not blank a card.
    expect(isDeclinedToolCallResult({ ...declined, exitCode: null })).toBe(true);
  });

  it('rejects a decline that states no decision', () => {
    // A declined card with nothing to say would be inventing the outcome.
    expect(isDeclinedToolCallResult({ kind: DECLINED_TOOL_RESULT_KIND })).toBe(false);
    expect(isDeclinedToolCallResult({ ...declined, message: '  ' })).toBe(false);
  });

  it('rejects other results, including error shapes that merely mention a decline', () => {
    expect(isDeclinedToolCallResult({ kind: 'cancelled', message: 'stopped' })).toBe(false);
    expect(isDeclinedToolCallResult(declined.message)).toBe(false);
    expect(isDeclinedToolCallResult(undefined)).toBe(false);
    expect(isDeclinedToolCallResult(null)).toBe(false);
    expect(isDeclinedToolCallResult([declined])).toBe(false);
  });
});
