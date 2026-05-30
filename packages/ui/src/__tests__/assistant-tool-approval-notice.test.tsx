import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssistantToolApprovalNotice } from '../assistant-ui-panel/assistant-tool-approval-notice';

const baseApproval = {
  args: {
    path: 'README.md',
    replacement: 'updated text',
  },
  resumeSchema: {
    type: 'object',
  },
  runId: 'run-approval-1',
  toolCallId: 'tool-call-1',
  toolName: 'workspace.writeFile',
} satisfies AssistantToolApprovalRequest;

describe('AssistantToolApprovalNotice', () => {
  it('renders a compact pending approval row by default', () => {
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByTestId('assistant-tool-approval-notice')).toBeInTheDocument();
    expect(screen.getByText('Tool approval required')).toBeInTheDocument();
    expect(screen.getByText('workspace.writeFile')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
  });

  it('expands to show approval identifiers and arguments', async () => {
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /expand tool approval details/i }));

    expect(screen.getByText('runId')).toBeInTheDocument();
    expect(screen.getByText('run-approval-1')).toBeInTheDocument();
    expect(screen.getByText('toolCallId')).toBeInTheDocument();
    expect(screen.getByText('tool-call-1')).toBeInTheDocument();
    expect(screen.getByText('args')).toBeInTheDocument();
    expect(screen.getByText(/README\.md/)).toBeInTheDocument();
    expect(screen.getByText('resumeSchema')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /collapse tool approval details/i })
    ).toBeInTheDocument();
  });

  it('renders nothing for malformed approval data', () => {
    const { container } = render(
      <AssistantToolApprovalNotice data={{ toolName: 'missing ids' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
