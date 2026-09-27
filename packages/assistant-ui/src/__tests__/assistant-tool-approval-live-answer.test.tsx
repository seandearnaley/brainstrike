import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantDecisionRecoveryProvider } from '../assistant-decision-recovery-provider';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { expandApprovalRow } from './approval-row-helpers';

const messages = vi.hoisted(
  () =>
    [] as Array<{
      content?: readonly unknown[];
      role: 'assistant' | 'user';
      status?: { error?: unknown; reason?: string; type: string };
    }>
);

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useAuiState: (
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => unknown
  ) => selector({ thread: { isRunning: false, messages } }),
}));

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
const approval = {
  delegation,
  riskCategory: 'read',
  runId: 'root-run',
  toolCallId: 'background-child-2',
  toolName: 'brainstrike.queryEmbeddingSpace',
} satisfies AssistantToolApprovalRequest;

function answer(
  decision: 'approve' | 'decline',
  reason: 'session-grant' | 'user'
): (typeof messages)[number] {
  return {
    content: [
      {
        data: { ...approval, decision, reason },
        name: 'brainstrike.tool-approval-answered',
        type: 'data',
      },
    ],
    role: 'assistant',
  };
}

function renderNotice() {
  return render(
    <AnsweredApprovalsProvider>
      <AssistantToolApprovalNotice data={approval} />
    </AnsweredApprovalsProvider>
  );
}

describe('AssistantToolApprovalNotice live answers', () => {
  beforeEach(() => messages.splice(0));

  it('locks as allowed once the host answers under a session grant', async () => {
    messages.push(answer('approve', 'session-grant'));
    renderNotice();
    await waitFor(() => expect(screen.getByText('Allowed by session grant')).toBeInTheDocument());
    await expandApprovalRow(userEvent.setup());
    expect(screen.getByRole('button', { name: /approve brainstrike/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline brainstrike/i })).toBeDisabled();
  });

  it("locks once the host applies the user's live answer", async () => {
    messages.push(answer('decline', 'user'));
    renderNotice();
    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument());
    await expandApprovalRow(userEvent.setup());
    expect(screen.getByRole('button', { name: /approve brainstrike/i })).toBeDisabled();
  });

  it('keeps a completed initiating approval settled without its transient user echo', async () => {
    const answeredRun = answer('approve', 'user');
    answeredRun.status = { reason: 'stop', type: 'complete' };
    messages.push(answeredRun, {
      content: [{ text: 'Both specialists finished.', type: 'text' }],
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    });
    const view = renderNotice();
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    await expandApprovalRow(userEvent.setup());
    expect(screen.getByRole('button', { name: /approve brainstrike/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline brainstrike/i })).toBeDisabled();

    // A later pause from the same delegation is still an independent decision.
    view.rerender(
      <AnsweredApprovalsProvider>
        <AssistantToolApprovalNotice
          data={{
            ...approval,
            delegation: { ...delegation, toolCallId: 'next-read' },
          }}
        />
      </AnsweredApprovalsProvider>
    );
    expect(screen.getByRole('button', { name: /approve brainstrike/i })).toBeEnabled();
  });

  it('unlocks the host answer when its resumed run fails', async () => {
    const answeredRun = answer('approve', 'user');
    messages.push(answeredRun);
    const view = renderNotice();
    await waitFor(() => expect(screen.getByText('Approved')).toBeInTheDocument());

    answeredRun.status = { error: 'resume_failed', reason: 'error', type: 'incomplete' };
    view.rerender(
      <AnsweredApprovalsProvider>
        <AssistantToolApprovalNotice data={approval} />
      </AnsweredApprovalsProvider>
    );

    expect(screen.getByRole('button', { name: /approve brainstrike/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /decline brainstrike/i })).toBeEnabled();
  });

  it('waits for hosted run reconciliation before retrying a failed approval', async () => {
    const answeredRun = answer('approve', 'user');
    answeredRun.status = { error: 'resume_failed', reason: 'error', type: 'incomplete' };
    messages.push(answeredRun);
    const view = render(
      <AssistantDecisionRecoveryProvider blocked>
        <AnsweredApprovalsProvider>
          <AssistantToolApprovalNotice data={approval} />
        </AnsweredApprovalsProvider>
      </AssistantDecisionRecoveryProvider>
    );

    const approve = screen.getByRole('button', { name: /approve brainstrike/i });
    expect(approve).toBeDisabled();
    view.rerender(
      <AssistantDecisionRecoveryProvider blocked={false}>
        <AnsweredApprovalsProvider>
          <AssistantToolApprovalNotice data={approval} />
        </AnsweredApprovalsProvider>
      </AssistantDecisionRecoveryProvider>
    );
    expect(approve).toBeEnabled();
  });
});
