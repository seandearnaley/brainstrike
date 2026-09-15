import { describe, expect, it } from 'vitest';
import { buildApprovalDecisionMessage } from '../approval-decision-message';

const delegation = {
  path: [
    {
      childRuntimeRunId: 'child-run',
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'delegate-1',
      personaId: 'explore',
    },
  ],
  toolCallId: 'leaf-1',
};

describe('buildApprovalDecisionMessage', () => {
  it('builds the exact bookkeeping message the card appends, keyed like the notice', () => {
    const built = buildApprovalDecisionMessage(
      {
        delegation,
        runId: 'root-run',
        toolCallId: 'delegate-1',
        toolName: 'brainstrike.grepSearch',
      },
      'approve'
    );
    const action = {
      action: 'approve',
      delegation,
      runId: 'root-run',
      toolCallId: 'delegate-1',
      toolName: 'brainstrike.grepSearch',
    };
    expect(built.identityKey).toBe(JSON.stringify(['child-run', 'leaf-1']));
    expect(built.text).toBe('Approved brainstrike.grepSearch.');
    expect(built.message).toEqual({
      content: [{ text: 'Approved brainstrike.grepSearch.', type: 'text' }],
      metadata: { custom: { brainstrikeToolApproval: action } },
      role: 'user',
      runConfig: { custom: { brainstrikeToolApproval: action } },
      startRun: true,
    });
  });

  it('routes a root pause to its own ids and says Declined for a decline', () => {
    const built = buildApprovalDecisionMessage(
      { runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.executeCommand' },
      'decline'
    );
    expect(built.identityKey).toBe(JSON.stringify(['run-1', 'call-1']));
    expect(built.text).toBe('Declined brainstrike.executeCommand.');
    expect(built.message).toMatchObject({
      runConfig: {
        custom: {
          brainstrikeToolApproval: {
            action: 'decline',
            runId: 'run-1',
            toolCallId: 'call-1',
            toolName: 'brainstrike.executeCommand',
          },
        },
      },
    });
  });
});
