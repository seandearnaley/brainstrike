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

  it("carries the pause's durable host leg into the echo the adapter anchors on", () => {
    // The marker's `runId` is the NATIVE Mastra run the resume route addresses;
    // it never matches a thread-run row. The history topology adapter needs the
    // host leg that surfaced the pause, so the echo must carry it verbatim.
    const built = buildApprovalDecisionMessage(
      {
        hostRunId: 'run-host-leg-1',
        runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
        toolCallId: 'call-1',
        toolName: 'brainstrike.executeCommand',
      },
      'approve'
    );
    const action = {
      action: 'approve',
      hostRunId: 'run-host-leg-1',
      runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
      toolCallId: 'call-1',
      toolName: 'brainstrike.executeCommand',
    };
    expect(built.message).toMatchObject({
      metadata: { custom: { brainstrikeToolApproval: action } },
      runConfig: { custom: { brainstrikeToolApproval: action } },
    });
  });

  it('omits the host leg when the pause named none (a rediscovered pause)', () => {
    const built = buildApprovalDecisionMessage(
      { runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.executeCommand' },
      'approve'
    );
    // Exact equality, so a fabricated host leg cannot slip in unnoticed.
    const action = {
      action: 'approve',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'brainstrike.executeCommand',
    };
    expect(built.message).toEqual({
      content: [{ text: 'Approved brainstrike.executeCommand.', type: 'text' }],
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
