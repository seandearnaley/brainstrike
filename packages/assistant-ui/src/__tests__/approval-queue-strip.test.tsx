import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveThreadKeyContext } from '../active-thread-key-context';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { buildApprovalDecisionMessage } from '../approval-decision-message';
import {
  type ApprovalOwnerThread,
  ApprovalOwnerThreadContext,
} from '../approval-owner-thread-context';
import { ApprovalRanksProvider } from '../approval-presentation-context';
import { ApprovalQueueStrip } from '../approval-queue-strip';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import type { DecisionRoute } from '../decision-route-context';
import { DecisionRouteContext } from '../decision-route-context';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import { DelegatedApprovalOwnerContext } from '../subagent-conversation-navigation';
import {
  type ToolApprovalGrantHandlers,
  ToolApprovalGrantProvider,
} from '../tool-approval-grant-context';
import { expandApprovalRow } from './approval-row-helpers';

const appendMock = vi.hoisted(() => vi.fn());
// Held by reference so a test can hand the provider a NEW array identity
// (as the real store does on every update); the incremental index only
// advances on a new array.
const threadMessagesMock = vi.hoisted(() => ({ current: [] as unknown[] }));
const threadRunningMock = vi.hoisted(() => ({ isRunning: true }));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ thread: () => ({ append: appendMock }) }),
  useAuiState: (
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => unknown
  ) =>
    selector({
      thread: { isRunning: threadRunningMock.isRunning, messages: threadMessagesMock.current },
    }),
}));

const edge = (n: number) => ({
  childRuntimeRunId: `child-run-${n}`,
  parentRuntimeRunId: 'root-run',
  parentToolCallId: `delegate-${n}`,
  personaId: 'explore',
});

function approval(n: number, riskCategory: 'read' | 'edit'): AssistantToolApprovalRequest {
  return {
    delegation: { path: [edge(n)], toolCallId: `leaf-${n}` },
    riskCategory,
    runId: 'root-run',
    toolCallId: `delegate-${n}`,
    toolName: riskCategory === 'read' ? 'brainstrike.grepSearch' : 'brainstrike.writeWorkspaceFile',
  };
}

const requestPart = (data: AssistantToolApprovalRequest) => ({
  data,
  name: TOOL_APPROVAL_DATA_NAME,
  type: 'data',
});
const answeredPart = (data: AssistantToolApprovalRequest) => ({
  data: {
    decision: 'approve',
    delegation: data.delegation,
    reason: 'session-grant',
    runId: data.runId,
    toolCallId: data.toolCallId,
    toolName: data.toolName,
  },
  name: 'brainstrike.tool-approval-answered',
  type: 'data',
});

function pushMessage(message: unknown): void {
  threadMessagesMock.current = [...threadMessagesMock.current, message];
}

function makeHandlers() {
  return {
    grantAllToolsForSession: vi.fn<ToolApprovalGrantHandlers['grantAllToolsForSession']>(),
    grantCategoryForSession: vi.fn<ToolApprovalGrantHandlers['grantCategoryForSession']>(),
    grantToolAlways: vi.fn<ToolApprovalGrantHandlers['grantToolAlways']>(),
  } satisfies ToolApprovalGrantHandlers;
}

function Tree({
  decisionRoute = null,
  handlers,
  ownerThread = null,
  timelineRequest,
  threadKey = 'thread-1',
}: {
  threadKey?: string;
  timelineRequest?: AssistantToolApprovalRequest;
  decisionRoute?: DecisionRoute | null;
  ownerThread?: ApprovalOwnerThread | null;
  handlers: ToolApprovalGrantHandlers | null;
}) {
  return (
    <ActiveThreadKeyContext.Provider value={threadKey}>
      <DecisionRouteContext value={decisionRoute}>
        <ApprovalOwnerThreadContext value={ownerThread}>
          <AnsweredApprovalsProvider>
            <ApprovalRanksProvider>
              <ToolApprovalGrantProvider handlers={handlers}>
                {timelineRequest ? <AssistantToolApprovalNotice data={timelineRequest} /> : null}
                <ApprovalQueueStrip key={threadKey} />
              </ToolApprovalGrantProvider>
            </ApprovalRanksProvider>
          </AnsweredApprovalsProvider>
        </ApprovalOwnerThreadContext>
      </DecisionRouteContext>
    </ActiveThreadKeyContext.Provider>
  );
}

describe('ApprovalQueueStrip', () => {
  beforeEach(() => {
    resetFollowUpQueueStore();
    appendMock.mockReset();
    threadMessagesMock.current = [];
    threadRunningMock.isRunning = true;
  });

  it('reviews requests in timeline order with the child identity and exact command', async () => {
    const command = {
      ...approval(2, 'edit'),
      args: { command: 'git status --short && git diff --stat', cwd: 'packages/worker' },
      riskCategory: 'execute',
      toolName: 'brainstrike.executeCommand',
    } satisfies AssistantToolApprovalRequest;
    pushMessage({
      content: [
        requestPart({ ...approval(1, 'read'), args: { maxDepth: 1, path: 'src' } }),
        requestPart(command),
        requestPart(approval(3, 'read')),
      ],
      role: 'assistant',
    });
    const handlers = makeHandlers();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <DelegatedApprovalOwnerContext
          value={async (request) => ({
            colorId: 'amber',
            displayName: request.toolCallId === 'delegate-2' ? 'Orbit-0ac2b6' : 'Opal-445bc0',
          })}
        >
          <Tree handlers={handlers} />
        </DelegatedApprovalOwnerContext>
      </TooltipProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Review 3 pending approvals' }));
    const review = screen.getByRole('dialog', { name: 'Pending approvals' });
    expect(within(review).getByTestId('approval-arguments-preview')).toHaveTextContent(
      '"path": "src"'
    );
    expect(await within(review).findByText('Orbit-0ac2b6')).toBeVisible();
    expect(within(review).getByTestId('approval-command-code')).toHaveTextContent(
      command.args.command
    );
    expect(within(review).getByTestId('approval-command-cwd')).toHaveTextContent(command.args.cwd);
    expect(
      within(review)
        .getAllByTestId('approval-delegation-owner')
        .map((node) => node.textContent)
    ).toEqual(['Opal-445bc0', 'Orbit-0ac2b6', 'Opal-445bc0']);
    await user.click(
      within(review).getByRole('button', {
        name: 'Approve brainstrike.executeCommand',
      })
    );
    // The thread is running, so the decision queues behind its turn.
    expect(
      useFollowUpQueueStore
        .getState()
        .queuedByThread[followUpQueueKey('thread-1')]?.map((item) => item.message)
    ).toEqual([buildApprovalDecisionMessage(command, 'approve').message]);
    expect(handlers.grantCategoryForSession).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The queued decision leaves the count; focus returns to the review button.
    expect(screen.getByRole('button', { name: 'Review 2 pending approvals' })).toHaveFocus();
  });

  it('locks the timeline copy once a review decision is queued', async () => {
    const request = approval(1, 'read');
    pushMessage({ content: [requestPart(request)], role: 'assistant' });
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tree handlers={null} timelineRequest={request} />
      </TooltipProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Pending approvals' })).getByRole('button', {
        name: 'Approve brainstrike.grepSearch',
      })
    );
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('assistant-tool-approval-notice')).toHaveAttribute(
      'data-approval-presentation',
      'row'
    );
    await expandApprovalRow(user);
    const button = screen.getByRole('button', { name: 'Approve brainstrike.grepSearch' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline brainstrike.grepSearch' })).toBeDisabled();
    await user.click(button);
    expect(
      useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('thread-1')]
    ).toHaveLength(1);
  });

  it('closes review when switching threads', async () => {
    pushMessage({ content: [requestPart(approval(1, 'read'))], role: 'assistant' });
    const tree = (threadKey: string) => (
      <TooltipProvider>
        <Tree handlers={null} threadKey={threadKey} />
      </TooltipProvider>
    );
    const view = render(tree('first'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
    view.rerender(tree('second'));
    expect(screen.queryByRole('dialog', { name: 'Pending approvals' })).not.toBeInTheDocument();
  });

  it('renders nothing when no approval is pending', () => {
    render(<Tree handlers={makeHandlers()} />);
    expect(screen.queryByTestId('approval-queue-strip')).not.toBeInTheDocument();
  });

  it('reviews non-policy requests and removes their actions when answered', async () => {
    const request = {
      args: { target: 'report' },
      runId: 'root',
      toolCallId: 'external-1',
      toolName: 'external.inspect',
    };
    pushMessage({ content: [requestPart(request)], role: 'assistant' });
    const tree = () => (
      <TooltipProvider>
        <Tree handlers={null} />
      </TooltipProvider>
    );
    const view = render(tree());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
    expect(screen.getByTestId('approval-arguments-preview')).toHaveTextContent('report');
    expect(screen.queryByTestId('approval-grant-category-session')).not.toBeInTheDocument();
    pushMessage({ content: [answeredPart(request)], role: 'assistant' });
    view.rerender(tree());
    expect(await screen.findByText('All approvals handled.')).toBeVisible();
    expect(screen.queryByText('0 approvals waiting')).not.toBeInTheDocument();
    expect(screen.queryByText('Review 0')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve external.inspect' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close pending approvals' }));
    expect(screen.queryByTestId('approval-queue-strip')).not.toBeInTheDocument();
  });

  it('counts pending approvals per category and offers one grant per category', () => {
    pushMessage({
      content: [
        requestPart(approval(1, 'read')),
        requestPart(approval(2, 'read')),
        requestPart(approval(3, 'read')),
        requestPart(approval(4, 'edit')),
      ],
      id: 'm1',
      role: 'assistant',
    });
    render(<Tree handlers={makeHandlers()} />);
    expect(screen.getByTestId('approval-queue-strip')).toHaveTextContent('4 approvals waiting');
    expect(screen.getByTestId('approval-strip-count-read')).toHaveTextContent('3 reads');
    expect(screen.getByTestId('approval-strip-count-edit')).toHaveTextContent('1 edit');
    expect(screen.getByTestId('approval-strip-grant-read')).toHaveAccessibleName(
      'Allow reads this session for the 3 waiting approvals'
    );
    expect(screen.getByTestId('approval-strip-grant-edit')).toHaveAccessibleName(
      'Allow edits this session for the 1 waiting approval'
    );
  });

  it('one click grants the category, then queues a decision for ONLY the first pending approval of it', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    pushMessage({
      content: [
        requestPart(approval(1, 'read')),
        requestPart(approval(2, 'read')),
        requestPart(approval(4, 'edit')),
      ],
      id: 'm1',
      role: 'assistant',
    });
    const view = render(<Tree handlers={handlers} />);
    await user.click(screen.getByTestId('approval-strip-grant-read'));

    expect(handlers.grantCategoryForSession).toHaveBeenCalledWith('read');
    const queued = useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('thread-1')];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.message).toMatchObject({
      runConfig: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            delegation: { path: [edge(1)], toolCallId: 'leaf-1' },
          },
        },
      },
    });
    expect(appendMock).not.toHaveBeenCalled();

    // The host answers every read sibling on the leg; the strip shrinks to the edit.
    pushMessage({
      content: [answeredPart(approval(1, 'read')), answeredPart(approval(2, 'read'))],
      id: 'm2',
      role: 'assistant',
    });
    view.rerender(<Tree handlers={handlers} />);
    await waitFor(() =>
      expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('approval-strip-count-edit')).toHaveTextContent('1 edit');
  });

  it('routes a child bulk grant once through its owner without appending locally', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    const dispatch = vi.fn<DecisionRoute['dispatch']>().mockResolvedValue('sent');
    pushMessage({
      content: [requestPart(approval(1, 'read')), requestPart(approval(2, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(
      <Tree decisionRoute={{ dispatch, queueThreadKey: 'root-thread' }} handlers={handlers} />
    );
    await user.click(screen.getByTestId('approval-strip-grant-read'));

    expect(handlers.grantCategoryForSession).toHaveBeenCalledWith('read');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      runConfig: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            delegation: { path: [edge(1)], toolCallId: 'leaf-1' },
          },
        },
      },
    });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('removes a child bulk grant once it is queued on the owning root', async () => {
    const request = approval(1, 'read');
    const decision = buildApprovalDecisionMessage(request, 'approve');
    pushMessage({ content: [requestPart(request)], id: 'm1', role: 'assistant' });
    const dispatch = vi.fn<DecisionRoute['dispatch']>(async (message) => {
      useFollowUpQueueStore.getState().enqueueMessage(followUpQueueKey('registered-root'), {
        identityKey: getToolActionIdentityKey(request),
        message,
        text: decision.text,
      });
      return 'queued';
    });
    render(
      <Tree
        decisionRoute={{ dispatch, queueThreadKey: 'registered-root' }}
        handlers={makeHandlers()}
      />
    );
    await userEvent.click(screen.getByTestId('approval-strip-grant-read'));
    await waitFor(() =>
      expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument()
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(
      useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('registered-root')]
    ).toHaveLength(1);
  });

  it('excludes an approval already submitted in the owner transcript from bulk grants', () => {
    const request = approval(1, 'read');
    const decision = buildApprovalDecisionMessage(request, 'approve');
    if (typeof decision.message === 'string') {
      throw new Error('Expected structured decision');
    }
    const messages = [{ ...decision.message, id: 'root-decision' }];
    pushMessage({ content: [requestPart(request)], id: 'm1', role: 'assistant' });
    const ownerThread = { getState: () => ({ messages }), subscribe: () => () => undefined };
    render(<Tree handlers={makeHandlers()} ownerThread={ownerThread} />);
    expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument();
  });

  it('appends the decision when the thread is idle (the approval leg answers the siblings)', async () => {
    const user = userEvent.setup();
    threadRunningMock.isRunning = false;
    pushMessage({
      content: [requestPart(approval(1, 'read')), requestPart(approval(2, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(<Tree handlers={makeHandlers()} />);
    await user.click(screen.getByTestId('approval-strip-grant-read'));
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('shows counts but no grant button without a grant provider (web / ungated hosts)', () => {
    pushMessage({
      content: [requestPart(approval(1, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(<Tree handlers={null} />);
    expect(screen.getByTestId('approval-strip-count-read')).toHaveTextContent('1 read');
    expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument();
  });
});
