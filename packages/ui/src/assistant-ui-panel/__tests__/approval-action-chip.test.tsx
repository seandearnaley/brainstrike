import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
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

function suspendMessage(resumeData: unknown, text = 'Approved the plan.'): unknown {
  return {
    content: [{ text, type: 'text' }],
    id: 'suspend-user-1',
    metadata: {
      custom: {
        [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
          resumeData,
          runId: 'run-plan-1',
          toolCallId: 'call-plan-1',
          toolName: 'brainstrike.submitPlan',
        },
      },
    },
    role: 'user',
  };
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

  it('reads a free-text askUser answer into an answer-tone chip', () => {
    expect(
      readApprovalActionChipProps(suspendMessage('San Francisco', 'Answered: San Francisco'))
    ).toEqual({ label: 'Answered: San Francisco', tone: 'answer' });
  });

  it('reads a multi-select askUser answer (string array) into an answer-tone chip', () => {
    expect(
      readApprovalActionChipProps(suspendMessage(['alpha', 'beta'], 'Answered: alpha, beta'))
    ).toEqual({ label: 'Answered: alpha, beta', tone: 'answer' });
  });

  it('truncates a long answer', () => {
    const longAnswer = 'x'.repeat(200);
    const props = readApprovalActionChipProps(suspendMessage(longAnswer));
    expect(props?.tone).toBe('answer');
    expect(props?.label.endsWith('…')).toBe(true);
    expect(props?.label.length).toBeLessThan(100);
  });

  it('falls through to the bubble (null) for malformed resumeData — never chips on a guess', () => {
    // A record without a recognized plan action, and a non-string/array scalar:
    // neither may hide the user-visible text behind a wrong chip.
    expect(readApprovalActionChipProps(suspendMessage({ weird: true }))).toBeNull();
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
