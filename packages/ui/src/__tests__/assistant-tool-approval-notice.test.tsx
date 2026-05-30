import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantToolApprovalNotice } from '../assistant-ui-panel/assistant-tool-approval-notice';

const appendMessageMock = vi.hoisted(() => vi.fn());
const threadMessagesMock = vi.hoisted(
  () =>
    [] as Array<{
      metadata?: {
        custom?: Record<string, unknown>;
      };
      role: 'assistant' | 'user';
      status?: { error?: unknown; reason?: string; type: string };
    }>
);

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({
      append: appendMessageMock,
    }),
  }),
  useAuiState: (
    selector: (state: {
      thread: {
        messages: typeof threadMessagesMock;
      };
    }) => unknown
  ) =>
    selector({
      thread: {
        messages: threadMessagesMock,
      },
    }),
}));

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
  beforeEach(() => {
    appendMessageMock.mockReset();
    appendMessageMock.mockImplementation(
      (message: {
        metadata?: { custom?: Record<string, unknown> };
        role?: 'assistant' | 'user';
      }) => {
        threadMessagesMock.push({
          role: message.role ?? 'user',
          ...(message.metadata ? { metadata: message.metadata } : {}),
        });
      }
    );
    threadMessagesMock.splice(0);
  });

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

  it('appends approval actions with runConfig for the assistant runtime', async () => {
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Approved workspace.writeFile.' }],
        role: 'user',
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
              toolName: 'workspace.writeFile',
            },
          },
        },
      })
    );
    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
  });

  it('appends decline actions with runConfig for the assistant runtime', async () => {
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /decline workspace\.writefile/i }));

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Declined workspace.writeFile.' }],
        role: 'user',
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'decline',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
              toolName: 'workspace.writeFile',
            },
          },
        },
      })
    );
  });

  it('reenables approval actions when the appended approval run errors', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByText('Approved')).toBeInTheDocument();

    threadMessagesMock.push({
      role: 'assistant',
      status: {
        error: 'tool_approval_resume_unsupported',
        reason: 'error',
        type: 'incomplete',
      },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeEnabled();
    expect(screen.getByText('Pending')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('does not reenable approval actions after the matching run completes successfully', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    threadMessagesMock.push({
      role: 'assistant',
      status: { type: 'complete' },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByText('Approved')).toBeInTheDocument();

    threadMessagesMock.push({
      role: 'assistant',
      status: {
        error: 'later_unrelated_error',
        reason: 'error',
        type: 'incomplete',
      },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('does not reenable approval actions for a different approval run error', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            runId: 'other-run',
            toolCallId: 'other-tool-call',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });
    threadMessagesMock.push({
      role: 'assistant',
      status: {
        error: 'other_approval_error',
        reason: 'error',
        type: 'incomplete',
      },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('renders nothing for malformed approval data', () => {
    const { container } = render(
      <AssistantToolApprovalNotice data={{ toolName: 'missing ids' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
