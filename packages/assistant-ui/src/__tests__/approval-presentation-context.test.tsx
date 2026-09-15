import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActiveThreadKeyContext } from '../active-thread-key-context';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import {
  ApprovalRanksProvider,
  useApprovalRank,
  usePendingApprovalsByCategory,
} from '../approval-presentation-context';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';

const threadMessagesMock = vi.hoisted(() => [] as unknown[]);

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: { thread: { messages: unknown[] } }) => unknown) =>
    selector({ thread: { messages: threadMessagesMock } }),
}));

const edge = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'root-run',
  parentToolCallId: 'delegate-1',
  personaId: 'explore',
};
const readRequest = (leaf: string) => ({
  data: {
    delegation: { path: [edge], toolCallId: leaf },
    riskCategory: 'read',
    runId: 'root-run',
    toolCallId: 'delegate-1',
    toolName: 'brainstrike.grepSearch',
  },
  name: TOOL_APPROVAL_DATA_NAME,
  type: 'data',
});
const key = (leaf: string) => JSON.stringify(['child-run', leaf]);

function Probe({ leaf }: { leaf: string }) {
  const rank = useApprovalRank(key(leaf));
  return <span data-testid={`rank-${leaf}`}>{rank === null ? 'null' : String(rank)}</span>;
}

function Pending() {
  const pending = usePendingApprovalsByCategory();
  return (
    <span data-testid="pending">
      {[...pending].map(([category, keys]) => `${category}=${keys.length}`).join(';')}
    </span>
  );
}

function renderTree() {
  return render(
    <ActiveThreadKeyContext.Provider value="thread-1">
      <AnsweredApprovalsProvider>
        <ApprovalRanksProvider>
          <Probe leaf="leaf-1" />
          <Probe leaf="leaf-2" />
          <Probe leaf="leaf-3" />
          <Pending />
        </ApprovalRanksProvider>
      </AnsweredApprovalsProvider>
    </ActiveThreadKeyContext.Provider>
  );
}

describe('ApprovalRanksProvider', () => {
  it('ranks pending approvals per category and drops answered ones from the ranking', () => {
    resetFollowUpQueueStore();
    threadMessagesMock.splice(0);
    threadMessagesMock.push({
      content: [
        readRequest('leaf-1'),
        readRequest('leaf-2'),
        readRequest('leaf-3'),
        {
          data: {
            decision: 'approve',
            delegation: { path: [edge], toolCallId: 'leaf-1' },
            reason: 'session-grant',
            runId: 'root-run',
            toolCallId: 'delegate-1',
            toolName: 'brainstrike.grepSearch',
          },
          name: 'brainstrike.tool-approval-answered',
          type: 'data',
        },
      ],
      id: 'm1',
      role: 'assistant',
    });
    renderTree();
    expect(screen.getByTestId('rank-leaf-1')).toHaveTextContent('null');
    expect(screen.getByTestId('rank-leaf-2')).toHaveTextContent('0');
    expect(screen.getByTestId('rank-leaf-3')).toHaveTextContent('1');
    expect(screen.getByTestId('pending')).toHaveTextContent('category:read=2');
  });

  it('treats a decision waiting in the follow-up queue as decided', () => {
    resetFollowUpQueueStore();
    threadMessagesMock.splice(0);
    threadMessagesMock.push({
      content: [readRequest('leaf-1'), readRequest('leaf-2')],
      id: 'm1',
      role: 'assistant',
    });
    useFollowUpQueueStore.getState().enqueueMessage(followUpQueueKey('thread-1'), {
      identityKey: key('leaf-1'),
      message: 'Approved brainstrike.grepSearch.',
      text: 'Approved brainstrike.grepSearch.',
    });
    renderTree();
    expect(screen.getByTestId('rank-leaf-1')).toHaveTextContent('null');
    expect(screen.getByTestId('rank-leaf-2')).toHaveTextContent('0');
  });

  it('returns null without a provider', () => {
    threadMessagesMock.splice(0);
    render(<Probe leaf="leaf-1" />);
    expect(screen.getByTestId('rank-leaf-1')).toHaveTextContent('null');
  });
});
