import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalActionChip, readApprovalActionChipProps } from '../approval-action-chip';

function approvalMessage(action: 'approve' | 'decline', toolName?: string): unknown {
  return {
    content: [{ text: `${action === 'approve' ? 'Approved' : 'Declined'} tool.`, type: 'text' }],
    id: 'approval-user-1',
    metadata: {
      custom: {
        [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
          action,
          runId: 'run-1',
          toolCallId: 'call-1',
          ...(toolName ? { toolName } : {}),
        },
      },
    },
    role: 'user',
  };
}

function suspendMessage(
  resumeData: unknown,
  text = 'Approved the plan.',
  toolName: string | undefined = NATIVE_TOOL_ID.submitPlan
): unknown {
  return {
    content: [{ text, type: 'text' }],
    id: 'suspend-user-1',
    metadata: {
      custom: {
        [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
          resumeData,
          runId: 'run-plan-1',
          toolCallId: 'call-plan-1',
          ...(toolName === undefined ? {} : { toolName }),
        },
      },
    },
    role: 'user',
  };
}

/** A Gate B network resume, as the run_python notice actually produces it. */
function networkMessage(resumeData: unknown, text = 'You allowed example.com.'): unknown {
  return suspendMessage(resumeData, text, NATIVE_TOOL_ID.runPython);
}

describe('readApprovalActionChipProps (approval marker)', () => {
  it('reads an approve marker into chip props', () => {
    expect(
      readApprovalActionChipProps(approvalMessage('approve', 'brainstrike.executeCommand'))
    ).toEqual({ label: 'Approved', tone: 'approve', toolName: 'brainstrike.executeCommand' });
  });

  it('reads a decline marker into chip props', () => {
    expect(
      readApprovalActionChipProps(approvalMessage('decline', 'brainstrike.writeWorkspaceFile'))
    ).toEqual({ label: 'Declined', tone: 'decline', toolName: 'brainstrike.writeWorkspaceFile' });
  });

  it('labels a marker without a tool name generically (reader owns the full label)', () => {
    expect(readApprovalActionChipProps(approvalMessage('approve'))).toEqual({
      label: 'Approved tool call',
      tone: 'approve',
    });
  });

  it('returns null for an ordinary user message (renders the normal prompt bubble)', () => {
    expect(
      readApprovalActionChipProps({
        content: [{ text: 'hello', type: 'text' }],
        id: 'u1',
        metadata: { custom: {} },
        role: 'user',
      })
    ).toBeNull();
  });

  it('returns null for a non-user message carrying the marker shape', () => {
    const marked = approvalMessage('approve', 'brainstrike.executeCommand') as Record<
      string,
      unknown
    >;
    expect(readApprovalActionChipProps({ ...marked, role: 'assistant' })).toBeNull();
  });
});

describe('readApprovalActionChipProps (suspend marker — plan/askUser resumes)', () => {
  it('reads an approved-plan resume into an approve-tone chip', () => {
    expect(readApprovalActionChipProps(suspendMessage({ action: 'approved' }))).toEqual({
      label: 'Approved the plan',
      tone: 'approve',
    });
  });

  it('reads a rejected-plan resume into a decline-tone chip', () => {
    expect(
      readApprovalActionChipProps(suspendMessage({ action: 'rejected' }, 'Rejected the plan.'))
    ).toEqual({ label: 'Rejected the plan', tone: 'decline' });
  });

  it('notes feedback presence on a plan decision that carried feedback', () => {
    expect(
      readApprovalActionChipProps(
        suspendMessage({ action: 'rejected', feedback: 'try smaller steps' }, 'Rejected the plan.')
      )
    ).toEqual({ label: 'Rejected the plan (with feedback)', tone: 'decline' });
  });

  it('reads a free-text askUser {answer} envelope into an answer-tone chip', () => {
    expect(
      readApprovalActionChipProps(
        suspendMessage({ answer: 'San Francisco' }, 'Answered: San Francisco')
      )
    ).toEqual({ label: 'Answered: San Francisco', tone: 'answer' });
  });

  it('reads a multi-select askUser {answer} envelope (string array) into an answer-tone chip', () => {
    expect(
      readApprovalActionChipProps(
        suspendMessage({ answer: ['alpha', 'beta'] }, 'Answered: alpha, beta')
      )
    ).toEqual({ label: 'Answered: alpha, beta', tone: 'answer' });
  });

  it('LEGACY compat: still chips a bare pre-envelope askUser answer (string / string array)', () => {
    // Persisted action messages from before the envelope migration keep the
    // bare shape forever; they must keep rendering as chips, not bubbles.
    expect(
      readApprovalActionChipProps(suspendMessage('San Francisco', 'Answered: San Francisco'))
    ).toEqual({ label: 'Answered: San Francisco', tone: 'answer' });
    expect(
      readApprovalActionChipProps(suspendMessage(['alpha', 'beta'], 'Answered: alpha, beta'))
    ).toEqual({ label: 'Answered: alpha, beta', tone: 'answer' });
  });

  it('truncates a long answer', () => {
    const longAnswer = 'x'.repeat(200);
    const props = readApprovalActionChipProps(suspendMessage({ answer: longAnswer }));
    expect(props?.tone).toBe('answer');
    expect(props?.label.endsWith('…')).toBe(true);
    expect(props?.label.length).toBeLessThan(100);
  });

  it('reads a run_python network allow into an approve-tone chip', () => {
    // BST-1070 Gate B. Without this the decision was the ONLY resume shape that
    // fell through to a full prompt bubble, so the thread read
    // "You allowed example.com." as if the user had typed it — directly above a
    // card already naming the same domains. The chip is the consistent surface.
    expect(readApprovalActionChipProps(networkMessage({ action: 'allow' }))).toEqual({
      label: 'Allowed internet access',
      tone: 'approve',
    });
  });

  it('reads a run_python network denial into a decline-tone chip', () => {
    expect(
      readApprovalActionChipProps(
        networkMessage({ action: 'deny' }, "You didn't allow internet access.")
      )
    ).toEqual({ label: "Didn't allow internet access", tone: 'decline' });
  });

  it('does not name the domains on the chip (the card above already states them)', () => {
    // The resume payload deliberately carries ONLY the decision — the Gate B
    // resume schema is strict and the tool's fail-safe requires exactly one key
    // — so a domain-naming chip would have to invent or re-plumb them.
    const props = readApprovalActionChipProps(networkMessage({ action: 'allow' }));
    expect(props?.label).not.toContain('example.com');
  });

  it('refuses an allow payload carrying extra keys (matches the tool fail-safe)', () => {
    // `readNetworkDecision` (run-python-tool.ts) treats any object without
    // EXACTLY one own key as DENY, and the Gate B resume schema is .strict().
    // A looser reader would chip "Allowed internet access" for a payload the run
    // actually denied — asserting a grant that never happened, which is the one
    // direction that matters for a security gate.
    expect(readApprovalActionChipProps(networkMessage({ action: 'allow', extra: 1 }))).toBeNull();
    expect(readApprovalActionChipProps(networkMessage({ action: 'deny', extra: 1 }))).toBeNull();
  });

  it('only reads the network vocabulary for a run_python resume', () => {
    // `{action: 'allow'}` is meaningful only for run_python's Gate B. The suspend
    // contract narrows suspendPayload BY TOOL NAME, and the notice dispatches the
    // same way — so a future suspending tool reusing this vocabulary must not
    // silently inherit the network label.
    expect(
      readApprovalActionChipProps(
        suspendMessage({ action: 'allow' }, 'Allowed something else.', 'brainstrike.someOtherTool')
      )
    ).toBeNull();
    expect(
      readApprovalActionChipProps(suspendMessage({ action: 'allow' }, 'No tool name.', undefined))
    ).toBeNull();
  });

  it('falls through to the bubble (null) for malformed resumeData — never chips on a guess', () => {
    // A record with neither a recognized plan action nor a valid {answer}
    // envelope, and a non-string/array scalar: neither may hide the
    // user-visible text behind a wrong chip.
    expect(readApprovalActionChipProps(suspendMessage({ weird: true }))).toBeNull();
    expect(readApprovalActionChipProps(suspendMessage({ answer: 42 }))).toBeNull();
    expect(readApprovalActionChipProps(suspendMessage({ answer: '' }))).toBeNull();
    expect(readApprovalActionChipProps(suspendMessage(42))).toBeNull();
    expect(readApprovalActionChipProps(suspendMessage(['ok', 7]))).toBeNull();
    expect(readApprovalActionChipProps(suspendMessage(''))).toBeNull();
  });

  it('falls through to the bubble (null) when the suspend marker itself is malformed', () => {
    expect(
      readApprovalActionChipProps({
        content: [{ text: 'Approved the plan.', type: 'text' }],
        id: 'suspend-user-2',
        metadata: {
          custom: {
            // Missing runId/toolCallId → not a valid resume action.
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: { resumeData: { action: 'approved' } },
          },
        },
        role: 'user',
      })
    ).toBeNull();
  });
});

describe('ApprovalActionChip', () => {
  it('renders a compact approved-outcome chip naming the tool', () => {
    render(
      <ApprovalActionChip label="Approved" tone="approve" toolName="brainstrike.executeCommand" />
    );

    const chip = screen.getByTestId('approval-action-chip');
    expect(chip.textContent).toContain('Approved brainstrike.executeCommand');
  });

  it('renders a declined-outcome chip', () => {
    render(
      <ApprovalActionChip label="Declined" tone="decline" toolName="brainstrike.executeCommand" />
    );

    expect(screen.getByTestId('approval-action-chip').textContent).toContain(
      'Declined brainstrike.executeCommand'
    );
  });

  it('renders a reader-provided generic label verbatim when no tool name is present', () => {
    render(<ApprovalActionChip label="Approved tool call" tone="approve" />);

    expect(screen.getByTestId('approval-action-chip').textContent?.trim()).toBe(
      'Approved tool call'
    );
  });

  it('renders a network-outcome chip end to end, replacing the prompt bubble', () => {
    const props = readApprovalActionChipProps(networkMessage({ action: 'allow' }));
    if (!props) {
      throw new Error('expected network chip props');
    }
    render(<ApprovalActionChip {...props} />);

    expect(screen.getByTestId('approval-action-chip').textContent?.trim()).toBe(
      'Allowed internet access'
    );
  });

  it('renders a plan-outcome chip without a tool-name suffix', () => {
    render(<ApprovalActionChip label="Approved the plan" tone="approve" />);

    expect(screen.getByTestId('approval-action-chip').textContent?.trim()).toBe(
      'Approved the plan'
    );
  });

  it('renders an answer chip', () => {
    render(<ApprovalActionChip label="Answered: San Francisco" tone="answer" />);

    expect(screen.getByTestId('approval-action-chip').textContent).toContain(
      'Answered: San Francisco'
    );
  });
});
