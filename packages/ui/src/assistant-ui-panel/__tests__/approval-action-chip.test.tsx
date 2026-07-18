import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
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

describe('readApprovalActionChipProps', () => {
  it('reads an approve marker into chip props', () => {
    expect(
      readApprovalActionChipProps(approvalMessage('approve', 'brainstrike.executeCommand'))
    ).toEqual({ action: 'approve', toolName: 'brainstrike.executeCommand' });
  });

  it('reads a decline marker into chip props', () => {
    expect(
      readApprovalActionChipProps(approvalMessage('decline', 'brainstrike.writeWorkspaceFile'))
    ).toEqual({ action: 'decline', toolName: 'brainstrike.writeWorkspaceFile' });
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

describe('ApprovalActionChip', () => {
  it('renders a compact approved-outcome chip naming the tool', () => {
    render(<ApprovalActionChip action="approve" toolName="brainstrike.executeCommand" />);

    const chip = screen.getByTestId('approval-action-chip');
    expect(chip.textContent).toContain('Approved brainstrike.executeCommand');
  });

  it('renders a declined-outcome chip', () => {
    render(<ApprovalActionChip action="decline" toolName="brainstrike.executeCommand" />);

    expect(screen.getByTestId('approval-action-chip').textContent).toContain(
      'Declined brainstrike.executeCommand'
    );
  });

  it('falls back to a generic label when the action carries no tool name', () => {
    render(<ApprovalActionChip action="approve" toolName={undefined} />);

    expect(screen.getByTestId('approval-action-chip').textContent).toContain('Approved tool call');
  });
});
