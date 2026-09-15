import {
  type AssistantToolApprovalRequest,
  type RediscoveredToolApproval,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveThreadKeyContext } from '../active-thread-key-context';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { ApprovalRanksProvider } from '../approval-presentation-context';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { delegationColourIndex } from '../delegation-colour';
import { resetFollowUpQueueStore } from '../follow-up-queue-store';
import { expandApprovalRow } from './approval-row-helpers';

const appendMock = vi.hoisted(() => vi.fn());
// Held by reference so a test can hand the provider a NEW array identity
// (as the real store does on every update); mutating one array in place
// would never advance the incremental index.
const threadMessagesMock = vi.hoisted(() => ({ current: [] as unknown[] }));
const threadRunningMock = vi.hoisted(() => ({ isRunning: false }));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ thread: () => ({ append: appendMock }) }),
  useAuiState: (
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => unknown
  ) =>
    selector({
      thread: { isRunning: threadRunningMock.isRunning, messages: threadMessagesMock.current },
    }),
}));

const rootEdge = {
  childRuntimeRunId: 'child-run-1',
  parentRuntimeRunId: 'root-run',
  parentToolCallId: 'delegate-1',
  personaId: 'explore',
};
const grandchildEdge = {
  childRuntimeRunId: 'grandchild-run-1',
  parentRuntimeRunId: 'child-run-1',
  parentToolCallId: 'delegate-1-1',
  personaId: 'analyze',
};

function readApproval(leaf: string, path = [rootEdge]): AssistantToolApprovalRequest {
  return {
    args: { path: 'apps/desktop' },
    delegation: { path, toolCallId: leaf },
    riskCategory: 'read',
    runId: 'root-run',
    toolCallId: path[0]?.parentToolCallId ?? 'delegate-1',
    toolName: 'brainstrike.readWorkspaceDirectory',
  };
}

function requestPart(approval: AssistantToolApprovalRequest) {
  return { data: approval, name: TOOL_APPROVAL_DATA_NAME, type: 'data' };
}

function answeredPart(approval: AssistantToolApprovalRequest, reason: 'session-grant' | 'user') {
  return {
    data: {
      decision: 'approve',
      delegation: approval.delegation,
      reason,
      runId: approval.runId,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
    },
    name: 'brainstrike.tool-approval-answered',
    type: 'data',
  };
}

function pushMessage(message: unknown): void {
  threadMessagesMock.current = [...threadMessagesMock.current, message];
}

function renderNotices(approvals: readonly AssistantToolApprovalRequest[]) {
  return render(
    <ActiveThreadKeyContext.Provider value="thread-1">
      <AnsweredApprovalsProvider>
        <ApprovalRanksProvider>
          {approvals.map((approval) => (
            <AssistantToolApprovalNotice data={approval} key={approval.delegation?.toolCallId} />
          ))}
        </ApprovalRanksProvider>
      </AnsweredApprovalsProvider>
    </ActiveThreadKeyContext.Provider>
  );
}

describe('approval presentation: card vs row', () => {
  beforeEach(() => {
    resetFollowUpQueueStore();
    appendMock.mockReset();
    threadMessagesMock.current = [];
    threadRunningMock.isRunning = false;
  });

  it('renders one full card per category and rows for the pending approvals behind it', () => {
    const first = readApproval('leaf-1');
    const second = readApproval('leaf-2');
    pushMessage({
      content: [requestPart(first), requestPart(second)],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([first, second]);
    const notices = screen.getAllByTestId('assistant-tool-approval-notice');
    expect(notices.map((node) => node.getAttribute('data-approval-presentation'))).toEqual([
      'card',
      'row',
    ]);
    // The card is actionable; the row behind it shows the tool and Pending.
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceDirectory' })
    ).toBeEnabled();
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Pending');
  });

  it('collapses a card into a row when the host answers it, and promotes the next pending one', async () => {
    const first = readApproval('leaf-1');
    const second = readApproval('leaf-2');
    pushMessage({
      content: [requestPart(first), requestPart(second)],
      id: 'm1',
      role: 'assistant',
    });
    const view = renderNotices([first, second]);
    expect(screen.getAllByTestId('assistant-tool-approval-notice')[0]).toHaveAttribute(
      'data-approval-presentation',
      'card'
    );

    // A session grant on a sibling answers this card: the answered part lands.
    pushMessage({
      content: [answeredPart(first, 'session-grant')],
      id: 'm2',
      role: 'assistant',
    });
    view.rerender(
      <ActiveThreadKeyContext.Provider value="thread-1">
        <AnsweredApprovalsProvider>
          <ApprovalRanksProvider>
            <AssistantToolApprovalNotice data={first} key="leaf-1" />
            <AssistantToolApprovalNotice data={second} key="leaf-2" />
          </ApprovalRanksProvider>
        </AnsweredApprovalsProvider>
      </ActiveThreadKeyContext.Provider>
    );
    await waitFor(() => {
      const notices = screen.getAllByTestId('assistant-tool-approval-notice');
      expect(notices.map((node) => node.getAttribute('data-approval-presentation'))).toEqual([
        'row',
        'card',
      ]);
    });
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Allowed by session grant');
  });

  it('a row names its persona, the requested action and its status — never colour alone', () => {
    const answered = readApproval('leaf-1');
    pushMessage({
      content: [requestPart(answered), answeredPart(answered, 'user')],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([answered]);
    const row = screen.getByTestId('assistant-tool-approval-notice');
    expect(row).toHaveAttribute('data-approval-presentation', 'row');
    expect(row).toHaveAttribute(
      'data-delegation-colour',
      String(delegationColourIndex('delegate-1'))
    );
    expect(screen.getByTestId('approval-delegation-owner')).toHaveTextContent('Explorer');
    // `verbForTool('brainstrike.readWorkspaceDirectory').done` is "Listed"
    // (`activity-verbs.ts`); the row lower-cases it as the requested action.
    expect(row).toHaveTextContent('listed');
    expect(row).toHaveTextContent('apps/desktop');
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
    expect(
      screen.getByRole('button', { name: /^Explorer listed apps\/desktop, show approval details$/ })
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a row into the locked full card and collapses it again', async () => {
    const user = userEvent.setup();
    const answered = readApproval('leaf-1');
    pushMessage({
      content: [requestPart(answered), answeredPart(answered, 'session-grant')],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([answered]);
    expect(screen.queryByTestId('approval-row-card')).not.toBeInTheDocument();
    await expandApprovalRow(user);
    expect(screen.getByTestId('approval-row-card')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceDirectory' })
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /hide approval details/i }));
    expect(screen.queryByTestId('approval-row-card')).not.toBeInTheDocument();
  });

  it('a pending row behind the category card expands into an ACTIONABLE card', async () => {
    const user = userEvent.setup();
    const first = readApproval('leaf-1');
    const second = readApproval('leaf-2');
    pushMessage({
      content: [requestPart(first), requestPart(second)],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([first, second]);
    await expandApprovalRow(user);
    const approveButtons = screen.getAllByRole('button', {
      name: 'Approve brainstrike.readWorkspaceDirectory',
    });
    expect(approveButtons).toHaveLength(2);
    await user.click(approveButtons[1] as HTMLElement);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock.mock.calls[0]?.[0]).toMatchObject({
      runConfig: {
        custom: { brainstrikeToolApproval: { delegation: second.delegation } },
      },
    });
  });

  it('the card the user answers collapses into a row showing the decision', async () => {
    const user = userEvent.setup();
    const only = readApproval('leaf-1');
    pushMessage({ content: [requestPart(only)], id: 'm1', role: 'assistant' });
    renderNotices([only]);
    await user.click(
      screen.getByRole('button', { name: 'Decline brainstrike.readWorkspaceDirectory' })
    );
    expect(screen.getByTestId('assistant-tool-approval-notice')).toHaveAttribute(
      'data-approval-presentation',
      'row'
    );
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Declined');
  });

  it('nests a grandchild under its ancestor: depth 2, two rails, the persona chain', () => {
    const nested = readApproval('leaf-deep', [rootEdge, grandchildEdge]);
    pushMessage({ content: [requestPart(nested)], id: 'm1', role: 'assistant' });
    renderNotices([nested]);
    const card = screen.getByTestId('assistant-tool-approval-notice');
    expect(card).toHaveAttribute('data-approval-presentation', 'card');
    expect(card.style.getPropertyValue('--bs-approval-depth')).toBe('2');
    expect(card).toHaveAttribute(
      'data-delegation-colour',
      String(delegationColourIndex('delegate-1-1'))
    );
    const rails = card.querySelectorAll('.bs-approval-rail');
    expect([...rails].map((rail) => rail.getAttribute('data-delegation-colour'))).toEqual([
      String(delegationColourIndex('delegate-1')),
      String(delegationColourIndex('delegate-1-1')),
    ]);
    expect(screen.getByTestId('approval-delegation-owner')).toHaveTextContent('Explorer › Analyst');
  });

  it('an expanded nested row owns the nesting: the embedded card adds no depth, colour or rails', async () => {
    const user = userEvent.setup();
    const nested = readApproval('leaf-deep', [rootEdge, grandchildEdge]);
    pushMessage({
      content: [requestPart(nested), answeredPart(nested, 'user')],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([nested]);
    const row = screen.getByTestId('assistant-tool-approval-notice');
    expect(row).toHaveAttribute('data-approval-presentation', 'row');
    await expandApprovalRow(user);
    const card = screen.getByTestId('approval-row-card');
    expect(row).toContainElement(card);
    expect(card.style.getPropertyValue('--bs-approval-depth')).toBe('');
    expect(card).not.toHaveAttribute('data-delegation-colour');
    // One rail per ancestor edge for the whole row, never a second set inside the card.
    expect(row.querySelectorAll('.bs-approval-rail')).toHaveLength(2);
  });

  it('a root pause (no delegation) is depth 0 with no rail and reads as the assistant', () => {
    const root: AssistantToolApprovalRequest = {
      args: { command: 'git status' },
      riskCategory: 'execute',
      runId: 'root-run',
      toolCallId: 'call-1',
      toolName: 'brainstrike.executeCommand',
    };
    pushMessage({
      content: [requestPart(root), answeredPart(root, 'user')],
      id: 'm1',
      role: 'assistant',
    });
    renderNotices([root]);
    const row = screen.getByTestId('assistant-tool-approval-notice');
    expect(row).toHaveAttribute('data-approval-presentation', 'row');
    expect(row.style.getPropertyValue('--bs-approval-depth')).toBe('0');
    expect(row).not.toHaveAttribute('data-delegation-colour');
    expect(row.querySelectorAll('.bs-approval-rail')).toHaveLength(0);
    expect(screen.getByTestId('approval-delegation-owner')).toHaveTextContent('Assistant');
  });

  it.each([
    ['claimed', 'Decision in progress'],
    ['consumed', 'Decision already submitted'],
    ['interrupted', 'Decision interrupted'],
    ['cancelled', 'Turn cancelled'],
  ] as const)(
    'a %s durable decision collapses into a row that keeps its recovery status visible',
    async (decisionState, label) => {
      // Answered decisions collapse (SWARM-AWARE PRESENTATION), but the
      // recovery status is safety information: it must be readable on the
      // collapsed row, not only after the user opens it.
      const user = userEvent.setup();
      // The rediscovery wire shape (`RediscoveredToolApproval`): the durable
      // state rides beside the staleness fields the suspended-runs endpoint stamps.
      const recovered: RediscoveredToolApproval = {
        ...readApproval('leaf-1'),
        decisionState,
        stale: false,
        suspendedAt: '2026-09-10T00:00:00.000Z',
      };
      pushMessage({ content: [requestPart(recovered)], id: 'm1', role: 'assistant' });
      renderNotices([recovered]);
      const row = screen.getByTestId('assistant-tool-approval-notice');
      expect(row).toHaveAttribute('data-approval-presentation', 'row');
      expect(screen.queryByTestId('approval-row-card')).not.toBeInTheDocument();
      const status = screen.getByTestId('delegated-decision-recovery-status');
      expect(row).toContainElement(status);
      expect(status).toHaveTextContent(label);

      // Opening the row shows the locked card; the status is still rendered once.
      await expandApprovalRow(user);
      expect(screen.getAllByTestId('delegated-decision-recovery-status')).toHaveLength(1);
      expect(
        screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceDirectory' })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Decline brainstrike.readWorkspaceDirectory' })
      ).toBeDisabled();
      expect(appendMock).not.toHaveBeenCalled();
    }
  );
});
