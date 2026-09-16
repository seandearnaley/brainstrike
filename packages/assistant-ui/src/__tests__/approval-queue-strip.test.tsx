import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { render, screen, waitFor } from '@testing-library/react';
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
import type { DecisionRoute } from '../decision-route-context';
import { DecisionRouteContext } from '../decision-route-context';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import { LiveDecisionProvider } from '../live-decision-context';
import type { LiveDecisionTransport } from '../live-decision-transport';
import {
  type ToolApprovalGrantHandlers,
  ToolApprovalGrantProvider,
} from '../tool-approval-grant-context';

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
  transport,
}: {
  decisionRoute?: DecisionRoute | null;
  ownerThread?: ApprovalOwnerThread | null;
  handlers: ToolApprovalGrantHandlers | null;
  transport: LiveDecisionTransport | null;
}) {
  return (
    <ActiveThreadKeyContext.Provider value="thread-1">
      <DecisionRouteContext value={decisionRoute}>
        <ApprovalOwnerThreadContext value={ownerThread}>
          <AnsweredApprovalsProvider>
            <ApprovalRanksProvider>
              <ToolApprovalGrantProvider handlers={handlers}>
                <LiveDecisionProvider transport={transport}>
                  <ApprovalQueueStrip />
                </LiveDecisionProvider>
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

  it('renders nothing when no approval is pending', () => {
    render(<Tree handlers={makeHandlers()} transport={null} />);
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
    render(<Tree handlers={makeHandlers()} transport={null} />);
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

  it('one click grants the category, then approves ONLY the first pending approval of it through the live transport', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    const transport = vi.fn<LiveDecisionTransport>().mockResolvedValue('delivered');
    pushMessage({
      content: [
        requestPart(approval(1, 'read')),
        requestPart(approval(2, 'read')),
        requestPart(approval(4, 'edit')),
      ],
      id: 'm1',
      role: 'assistant',
    });
    const view = render(<Tree handlers={handlers} transport={transport} />);
    await user.click(screen.getByTestId('approval-strip-grant-read'));

    expect(handlers.grantCategoryForSession).toHaveBeenCalledWith('read');
    // Grant FIRST, then the decision — the same ordering contract as the card.
    expect(handlers.grantCategoryForSession.mock.invocationCallOrder[0]).toBeLessThan(
      transport.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
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
    view.rerender(<Tree handlers={handlers} transport={transport} />);
    await waitFor(() =>
      expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('approval-strip-count-edit')).toHaveTextContent('1 edit');
  });

  it('routes a child bulk grant once through its owner without appending locally', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    const dispatch = vi.fn<DecisionRoute['dispatch']>().mockResolvedValue('delivered');
    pushMessage({
      content: [requestPart(approval(1, 'read')), requestPart(approval(2, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(
      <Tree
        decisionRoute={{ dispatch, queueThreadKey: 'root-thread' }}
        handlers={handlers}
        transport={null}
      />
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
        transport={null}
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
    render(<Tree handlers={makeHandlers()} ownerThread={ownerThread} transport={null} />);
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
    render(<Tree handlers={makeHandlers()} transport={null} />);
    await user.click(screen.getByTestId('approval-strip-grant-read'));
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('locks the category button for the round trip and unlocks on a host refusal', async () => {
    const user = userEvent.setup();
    let reject: (error: Error) => void = () => {};
    const transport = vi.fn<LiveDecisionTransport>().mockImplementation(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        })
    );
    pushMessage({
      content: [requestPart(approval(1, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(<Tree handlers={makeHandlers()} transport={transport} />);
    await user.click(screen.getByTestId('approval-strip-grant-read'));
    expect(screen.getByTestId('approval-strip-grant-read')).toBeDisabled();
    reject(new Error('The decision was not applied: HTTP 409'));
    await waitFor(() => expect(screen.getByTestId('approval-strip-grant-read')).toBeEnabled());
  });

  it('shows counts but no grant button without a grant provider (web / ungated hosts)', () => {
    pushMessage({
      content: [requestPart(approval(1, 'read'))],
      id: 'm1',
      role: 'assistant',
    });
    render(<Tree handlers={null} transport={null} />);
    expect(screen.getByTestId('approval-strip-count-read')).toHaveTextContent('1 read');
    expect(screen.queryByTestId('approval-strip-grant-read')).not.toBeInTheDocument();
  });
});
