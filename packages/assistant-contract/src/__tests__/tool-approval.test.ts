import { describe, expect, it } from 'vitest';
import { readToolApprovalRunConfigAction, TOOL_APPROVAL_RUN_CONFIG_KEY } from '../tool-approval';

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
