// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import {
  type AssistantToolApprovalAnswered,
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { memo, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalOwnerThread } from '../approval-owner-thread-context';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { resetFollowUpQueueStore } from '../follow-up-queue-store';
import { expandApprovalRow } from './approval-row-helpers';

/**
 * A background child's read approval, live: the child view renders the
 * child's own copy (its stream's `decorate()` addresses the leaf run/call),
 * the ROOT thread renders the synthesized root card (`withRootPauseNotices`,
 * root edge) and, once the user's grant or decision is delivered into the
 * running leg, the host's `tool-approval-answered` part — on the ROOT stream
 * only (`live-decisions.ts`). All three share one identity key
 * (`getToolActionIdentityKey`: leaf childRuntimeRunId + leaf toolCallId).
 */
const edge = (child: string) => ({
  childRuntimeRunId: `child-run-${child}`,
  parentRuntimeRunId: 'root-run',
  parentToolCallId: `delegate-${child}`,
  personaId: 'explore',
});
const delegation = (child: string) => ({ path: [edge(child)], toolCallId: `leaf-read-${child}` });

const childNotice = (child: string): AssistantToolApprovalRequest => ({
  args: { path: 'README.md' },
  delegation: delegation(child),
  riskCategory: 'read',
  runId: `child-run-${child}`,
  toolCallId: `leaf-read-${child}`,
  toolName: 'brainstrike.readWorkspaceFile',
});
const rootCard = (child: string): AssistantToolApprovalRequest => ({
  ...childNotice(child),
  runId: 'root-run',
  toolCallId: `delegate-${child}`,
});
const rootAnswer = (
  child: string,
  reason: AssistantToolApprovalAnswered['reason']
): AssistantToolApprovalAnswered => ({
  decision: 'approve',
  delegation: delegation(child),
  reason,
  runId: 'root-run',
  toolCallId: `delegate-${child}`,
  toolName: 'brainstrike.readWorkspaceFile',
});

const dataPart = (name: string, data: object) => ({ data, name, type: 'data' as const });

const rootTurn = (answers: readonly AssistantToolApprovalAnswered[]): ThreadMessageLike => ({
  content: [
    dataPart(TOOL_APPROVAL_DATA_NAME, rootCard('2')),
    dataPart(TOOL_APPROVAL_DATA_NAME, rootCard('3')),
    ...answers.map((answer) => dataPart(TOOL_APPROVAL_ANSWERED_DATA_NAME, answer)),
  ],
  id: 'root-turn',
  role: 'assistant',
});
const CHILD_LEG: readonly ThreadMessageLike[] = [
  {
    content: [dataPart(TOOL_APPROVAL_DATA_NAME, childNotice('2'))],
    id: 'delegated-leg:["host-run","child-run-2"]',
    role: 'assistant',
  },
];
const asMessage = (message: ThreadMessageLike) => message;
const startsNothing = async () => undefined;

let answerFromRoot: ((answers: readonly AssistantToolApprovalAnswered[]) => void) | undefined;

/**
 * The child tab: its own runtime over the child leg, and the owning root's
 * thread received once. Memoized with stable inputs, so a root update reaches
 * it ONLY through the owner thread's subscription — the root panel and a
 * child tab are separate trees in the app.
 */
const ChildView = memo(function ChildView({
  ownerThread,
}: {
  readonly ownerThread: ApprovalOwnerThread;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: asMessage,
    isRunning: true,
    messages: CHILD_LEG,
    onNew: startsNothing,
  });
  return (
    <TooltipProvider>
      <AssistantConversationPanel
        label="Explorer 2"
        ownerThread={ownerThread}
        runtime={runtime}
        threadKey="child-thread-2"
      />
    </TooltipProvider>
  );
});

/** The owning root's real external-store runtime; its thread is registered once. */
function RootOwningChildView({
  initialAnswers,
}: {
  readonly initialAnswers: readonly AssistantToolApprovalAnswered[];
}) {
  const [answers, setAnswers] = useState(initialAnswers);
  answerFromRoot = setAnswers;
  const owner = useExternalStoreRuntime({
    convertMessage: asMessage,
    isRunning: true,
    messages: [rootTurn(answers)],
    onNew: startsNothing,
  });
  const [registered] = useState(() => owner.thread);
  return <ChildView ownerThread={registered} />;
}

const notice = () => screen.getByTestId('assistant-tool-approval-notice');

describe('child view approvals answered by the owning root', () => {
  afterEach(() => {
    cleanup();
    resetFollowUpQueueStore();
    answerFromRoot = undefined;
  });

  it.each([
    ['session-grant', 'Allowed by session grant'],
    ['user', 'Approved'],
  ] as const)(
    'renders a child approval the root answered (%s) as the locked answered row, never a pending card',
    async (reason, status) => {
      render(<RootOwningChildView initialAnswers={[rootAnswer('2', reason)]} />);
      expect(notice()).toHaveAttribute('data-approval-presentation', 'row');
      expect(screen.getByTestId('approval-row-status')).toHaveTextContent(status);
      expect(screen.queryByText('Pending')).not.toBeInTheDocument();
      await expandApprovalRow(userEvent.setup());
      expect(
        screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
      ).toBeDisabled();
    }
  );

  it('collapses the open child card when the root answer arrives live', () => {
    render(<RootOwningChildView initialAnswers={[]} />);
    expect(notice()).toHaveAttribute('data-approval-presentation', 'card');
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeEnabled();
    act(() => answerFromRoot?.([rootAnswer('2', 'session-grant')]));
    expect(notice()).toHaveAttribute('data-approval-presentation', 'row');
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Allowed by session grant');
  });

  it("keeps the child's genuinely pending card actionable when the root answered only a sibling", () => {
    render(<RootOwningChildView initialAnswers={[rootAnswer('3', 'session-grant')]} />);
    expect(notice()).toHaveAttribute('data-approval-presentation', 'card');
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeEnabled();
  });
});
