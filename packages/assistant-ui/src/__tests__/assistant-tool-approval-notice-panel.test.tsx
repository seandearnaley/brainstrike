import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveThreadKeyContext } from '../active-thread-key-context';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import { LiveDecisionProvider } from '../live-decision-context';
import { expandApprovalRow } from './approval-row-helpers';

const appendMessageMock = vi.hoisted(() => vi.fn());
const threadMessagesMock = vi.hoisted(
  () =>
    [] as Array<{
      content?: readonly unknown[];
      metadata?: {
        custom?: Record<string, unknown>;
      };
      role: 'assistant' | 'user';
      status?: { error?: unknown; reason?: string; type: string };
    }>
);
const useAuiStateSelectorResults = vi.hoisted(() => [] as unknown[]);
const threadRunningMock = vi.hoisted(() => ({ isRunning: false }));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({
      append: appendMessageMock,
    }),
  }),
  useAuiState: (
    selector: (state: {
      thread: {
        isRunning: boolean;
        messages: typeof threadMessagesMock;
      };
    }) => unknown
  ) => {
    const state = {
      thread: {
        isRunning: threadRunningMock.isRunning,
        messages: threadMessagesMock,
      },
    };
    const firstResult = selector(state);
    const secondResult = selector(state);
    useAuiStateSelectorResults.push(firstResult, secondResult);
    return firstResult;
  },
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
    useAuiStateSelectorResults.splice(0);
  });

  it('renders a compact pending approval row by default', () => {
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByTestId('assistant-tool-approval-notice')).toBeInTheDocument();
    expect(screen.getByText('Tool approval required')).toBeInTheDocument();
    expect(screen.getByText('workspace.writeFile')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    // No risk reason without a riskCategory hint.
    expect(screen.queryByText(/Requires approval/i)).not.toBeInTheDocument();
  });

  it('shows the risk reason when the approval carries a riskCategory hint', () => {
    const approvalWithRisk: AssistantToolApprovalRequest = {
      ...baseApproval,
      policyDecision: 'ask',
      riskCategory: 'execute',
    };
    render(<AssistantToolApprovalNotice data={approvalWithRisk} />);

    expect(screen.getByText(/Requires approval/i)).toBeInTheDocument();
    // BST-1070 §6.1: the shared execute reason line covers code as well as commands.
    expect(screen.getByText(/runs commands or code on your computer/i)).toBeInTheDocument();
  });

  it('shows a "pending since" line and a stale advisory for a rediscovered stale approval, keeping both buttons enabled', () => {
    const staleApproval = {
      ...baseApproval,
      stale: true,
      suspendedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    render(<AssistantToolApprovalNotice data={staleApproval} />);

    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
    expect(screen.getByText(/pending a while/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeEnabled();
  });

  it('shows "pending since" but no advisory for a fresh (non-stale) rediscovered approval', () => {
    const freshApproval = {
      ...baseApproval,
      stale: false,
      suspendedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    };
    render(<AssistantToolApprovalNotice data={freshApproval} />);

    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending a while/i)).not.toBeInTheDocument();
  });

  it('renders a live approval (no suspendedAt) without the pending-since or advisory lines', () => {
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.queryByText(/pending since/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pending a while/i)).not.toBeInTheDocument();
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

  it.each(['parent', 'child'])(
    'routes %s cards to the root while keeping sequential leaf decisions distinct',
    async (surface) => {
      const user = userEvent.setup();
      const path = [
        {
          childRuntimeRunId: 'child-run',
          parentRuntimeRunId: 'root-run',
          parentToolCallId: 'delegate-1',
          personaId: 'explore',
        },
      ];
      const first = {
        ...baseApproval,
        delegation: { path, toolCallId: 'read-1' },
        runId: surface === 'parent' ? 'root-run' : 'child-run',
        toolCallId: surface === 'parent' ? 'delegate-1' : 'read-1',
      };
      const view = render(<AssistantToolApprovalNotice data={first} />);
      await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
      expect(appendMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runConfig: {
            custom: {
              brainstrikeToolApproval: {
                action: 'approve',
                delegation: first.delegation,
                runId: 'root-run',
                toolCallId: 'delegate-1',
                toolName: baseApproval.toolName,
              },
            },
          },
        })
      );
      const second = { ...first, delegation: { path, toolCallId: 'read-2' } };
      view.rerender(<AssistantToolApprovalNotice data={second} />);
      expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /decline workspace\.writefile/i }));
      expect(appendMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runConfig: {
            custom: {
              brainstrikeToolApproval: expect.objectContaining({
                action: 'decline',
                delegation: second.delegation,
              }),
            },
          },
        })
      );
    }
  );

  it('appends approval actions with runConfig for the assistant runtime', async () => {
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ text: 'Approved workspace.writeFile.', type: 'text' }],
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
    // An answered notice collapses into a row; its buttons live in the expanded body.
    await expandApprovalRow(user);
    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
  });

  it('appends decline actions with runConfig for the assistant runtime', async () => {
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /decline workspace\.writefile/i }));

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ text: 'Declined workspace.writeFile.', type: 'text' }],
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
    await expandApprovalRow(user);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');

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

  it('reenables approval actions when the appended approval run is interrupted', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    threadMessagesMock.push({
      role: 'assistant',
      status: {
        reason: 'cancelled',
        type: 'incomplete',
      },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeEnabled();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('reenables approval actions after a synchronous append failure', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await expect(
      user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }))
    ).resolves.toBeUndefined();

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeEnabled();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('shows why the decision was not sent after a synchronous append failure', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(screen.getByRole('alert')).toHaveTextContent('Decision not sent: append failed');
  });

  it('clears the send error once a retried decision is sent', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    await expandApprovalRow(user);

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops a stale send error once the approval is answered another way', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Decision not sent: append failed');

    // Another surface (the composer's approval strip) answered the same pause.
    // A failure from the earlier attempt must not sit next to the new status.
    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);
    await expandApprovalRow(user);

    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not resurrect the send error when that other run later fails', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    // That run fails, so the card unlocks again — with no stale failure text.
    threadMessagesMock.push({
      role: 'assistant',
      status: { error: 'resume_failed', reason: 'error', type: 'incomplete' },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeEnabled()
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not reenable approval actions after the matching run completes successfully', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    await expandApprovalRow(user);

    threadMessagesMock.push({
      role: 'assistant',
      status: { type: 'complete' },
    });
    view.rerender(<AssistantToolApprovalNotice data={baseApproval} />);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');

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
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
  });

  it('keeps restored completed approval actions disabled after remount', async () => {
    const user = userEvent.setup();
    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });
    threadMessagesMock.push({
      role: 'assistant',
      status: { type: 'complete' },
    });
    render(<AssistantToolApprovalNotice data={baseApproval} />);
    await expandApprovalRow(user);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));

    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('keeps restored pending approval actions disabled after remount', async () => {
    const user = userEvent.setup();
    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'decline',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });
    render(<AssistantToolApprovalNotice data={baseApproval} />);
    await expandApprovalRow(user);

    expect(screen.getByRole('button', { name: /approve workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline workspace\.writefile/i })).toBeDisabled();
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Declined');
  });

  it('returns a stable approval outcome selector value for unchanged thread state', () => {
    threadMessagesMock.push({
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            runId: 'run-approval-1',
            toolCallId: 'tool-call-1',
            toolName: 'workspace.writeFile',
          },
        },
      },
      role: 'user',
    });

    render(<AssistantToolApprovalNotice data={baseApproval} />);

    // Two thread selectors per card (run outcome, isRunning), each sampled
    // twice; every pair must be referentially stable.
    expect(useAuiStateSelectorResults).toHaveLength(4);
    for (let index = 0; index < useAuiStateSelectorResults.length; index += 2) {
      expect(useAuiStateSelectorResults[index]).toBe(useAuiStateSelectorResults[index + 1]);
    }
  });

  it('does not reenable approval actions for a different approval run error', async () => {
    const user = userEvent.setup();
    const view = render(<AssistantToolApprovalNotice data={baseApproval} />);

    await user.click(screen.getByRole('button', { name: /approve workspace\.writefile/i }));
    await expandApprovalRow(user);

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
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
  });

  it('renders nothing for malformed approval data', () => {
    const { container } = render(
      <AssistantToolApprovalNotice data={{ toolName: 'missing ids' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('AssistantToolApprovalNotice for a delegated child', () => {
  beforeEach(() => {
    threadMessagesMock.splice(0);
    useAuiStateSelectorResults.splice(0);
  });
  const delegation = {
    path: [
      {
        childRuntimeRunId: 'child-run-2',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'background-child-2',
        personaId: 'explore',
      },
    ],
    toolCallId: 'background-read-2',
  };
  const childApproval = {
    delegation,
    riskCategory: 'read',
    runId: 'root-run',
    toolCallId: 'background-child-2',
    toolName: 'brainstrike.queryEmbeddingSpace',
  } satisfies AssistantToolApprovalRequest;

  const renderIndexed = (data: unknown) =>
    render(
      <AnsweredApprovalsProvider>
        <AssistantToolApprovalNotice data={data} />
      </AnsweredApprovalsProvider>
    );

  it('names the child by persona and by the prompt the root gave it', async () => {
    threadMessagesMock.push({
      content: [
        {
          args: { prompt: 'Act as the frontend and UX specialist. Survey the renderer.' },
          toolCallId: 'background-child-2',
          toolName: 'agent-explore',
          type: 'tool-call',
        },
      ],
      role: 'assistant',
    });
    renderIndexed(childApproval);
    await waitFor(() =>
      expect(screen.getByTestId('approval-delegation-owner')).toBeInTheDocument()
    );
    expect(screen.getByTestId('approval-delegation-owner')).toHaveTextContent(
      'Explorer · Act as the frontend and UX specialist. Survey the renderer.'
    );
    expect(screen.getByText('brainstrike.queryEmbeddingSpace')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.queryEmbeddingSpace' })
    ).toBeEnabled();
  });

  it('locks as allowed once the host answers it under a session grant', async () => {
    threadMessagesMock.push({
      content: [
        {
          data: {
            decision: 'approve',
            delegation,
            reason: 'session-grant',
            runId: 'root-run',
            toolCallId: 'background-child-2',
            toolName: 'brainstrike.queryEmbeddingSpace',
          },
          name: 'brainstrike.tool-approval-answered',
          type: 'data',
        },
      ],
      role: 'assistant',
    });
    renderIndexed(childApproval);
    await waitFor(() => expect(screen.getByText('Allowed by session grant')).toBeInTheDocument());
    await expandApprovalRow(userEvent.setup());
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.queryEmbeddingSpace' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Decline brainstrike.queryEmbeddingSpace' })
    ).toBeDisabled();
  });

  it("locks with the decision once the host applied the user's own live answer", async () => {
    threadMessagesMock.push({
      content: [
        {
          data: {
            decision: 'decline',
            delegation,
            reason: 'user',
            runId: 'root-run',
            toolCallId: 'background-child-2',
            toolName: 'brainstrike.queryEmbeddingSpace',
          },
          name: 'brainstrike.tool-approval-answered',
          type: 'data',
        },
      ],
      role: 'assistant',
    });
    renderIndexed(childApproval);
    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument());
    await expandApprovalRow(userEvent.setup());
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.queryEmbeddingSpace' })
    ).toBeDisabled();
  });

  it('does not lock on an answer for a different child', async () => {
    threadMessagesMock.push({
      content: [
        {
          data: {
            decision: 'approve',
            delegation: { ...delegation, toolCallId: 'background-read-3' },
            reason: 'session-grant',
            runId: 'root-run',
            toolCallId: 'background-child-3',
            toolName: 'brainstrike.queryEmbeddingSpace',
          },
          name: 'brainstrike.tool-approval-answered',
          type: 'data',
        },
      ],
      role: 'assistant',
    });
    renderIndexed(childApproval);
    await waitFor(() =>
      expect(screen.getByTestId('approval-delegation-owner')).toHaveTextContent('Explorer')
    );
    expect(screen.queryByText('Allowed by session grant')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.queryEmbeddingSpace' })
    ).toBeEnabled();
  });
});

describe('AssistantToolApprovalNotice while a run is active', () => {
  beforeEach(() => {
    threadMessagesMock.splice(0);
    useAuiStateSelectorResults.splice(0);
    appendMessageMock.mockReset();
    resetFollowUpQueueStore();
    threadRunningMock.isRunning = false;
  });

  // Appending during a run cancels the run in the installed runtime; the
  // second of two quick decisions aborted the first's resume leg and was
  // lost (thread-b3cea1f6, 2026-09-14). A decision waits its turn instead.
  it('queues the decision instead of appending, shows Queued, and re-enables when the chip is removed', async () => {
    threadRunningMock.isRunning = true;
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <AssistantToolApprovalNotice data={baseApproval} />
      </ActiveThreadKeyContext.Provider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve workspace.writeFile' }));
    expect(appendMessageMock).not.toHaveBeenCalled();
    const queued = useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root-thread')];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]).toMatchObject({
      identityKey: JSON.stringify(['run-approval-1', 'tool-call-1']),
      message: { runConfig: { custom: { brainstrikeToolApproval: { action: 'approve' } } } },
      text: 'Approved workspace.writeFile.',
    });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    await expandApprovalRow(userEvent.setup());
    expect(screen.getByRole('button', { name: 'Approve workspace.writeFile' })).toBeDisabled();
    // The chip is the user's veto: removing it hands the card back.
    const item = queued?.[0];
    if (!item) {
      throw new Error('missing queued decision');
    }
    useFollowUpQueueStore.getState().remove(followUpQueueKey('root-thread'), item.id);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve workspace.writeFile' })).toBeEnabled()
    );
  });

  // The desktop delivers the decision INTO the running turn; the card locks
  // for the round trip and stays locked once delivered (the host's answer
  // chunk follows on the stream). A leg that settled meanwhile answers
  // 'no-live-run' and the decision queues exactly as without a transport.
  it('delivers into the running turn through the live transport and stays locked', async () => {
    threadRunningMock.isRunning = true;
    const transport = vi.fn(async (_message: unknown) => 'delivered' as const);
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <LiveDecisionProvider transport={transport}>
          <AssistantToolApprovalNotice data={baseApproval} />
        </LiveDecisionProvider>
      </ActiveThreadKeyContext.Provider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve workspace.writeFile' }));
    await waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      runConfig: { custom: { brainstrikeToolApproval: { action: 'approve' } } },
    });
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root-thread')]).toBe(
      undefined
    );
    await waitFor(() => expect(screen.getByText('Approved')).toBeInTheDocument());
    await expandApprovalRow(userEvent.setup());
    expect(screen.getByRole('button', { name: 'Approve workspace.writeFile' })).toBeDisabled();
  });

  it('queues and hands the card back when the transport reports no live run', async () => {
    threadRunningMock.isRunning = true;
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <LiveDecisionProvider transport={async () => 'no-live-run'}>
          <AssistantToolApprovalNotice data={baseApproval} />
        </LiveDecisionProvider>
      </ActiveThreadKeyContext.Provider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve workspace.writeFile' }));
    await waitFor(() => expect(screen.getByText('Queued')).toBeInTheDocument());
    expect(
      useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root-thread')]
    ).toHaveLength(1);
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('unlocks the card when the host refuses the live decision', async () => {
    threadRunningMock.isRunning = true;
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <LiveDecisionProvider
          transport={async () => {
            throw new Error('The decision was not applied: refused');
          }}
        >
          <AssistantToolApprovalNotice data={baseApproval} />
        </LiveDecisionProvider>
      </ActiveThreadKeyContext.Provider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve workspace.writeFile' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve workspace.writeFile' })).toBeEnabled()
    );
    expect(useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root-thread')]).toBe(
      undefined
    );
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Decision not sent: The decision was not applied: refused'
    );
  });

  it('appends immediately when no run is active', async () => {
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <AssistantToolApprovalNotice data={baseApproval} />
      </ActiveThreadKeyContext.Provider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve workspace.writeFile' }));
    expect(appendMessageMock).toHaveBeenCalledOnce();
    expect(useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root-thread')]).toBe(
      undefined
    );
  });
});
