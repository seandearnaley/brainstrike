import type { HostClient } from '@brainstrike/agent-host/browser';
import { openHostChildTab } from '@brainstrike/app-shell';
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import {
  type SubagentAnsweredApproval,
  SubagentApprovalHistoryContext,
  SubagentsRunningStrip,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { Button } from '@brainstrike/ui';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { type HostTreeApprovals, stopHostChildTurns } from './host-tree-approvals';

const logger = createLogger('HostChildTreeNotices');
const NO_HISTORY: readonly SubagentAnsweredApproval[] = [];

/**
 * Live QA 2026-10-16: the root's background children still working, named at
 * its composer. This stops their turns through the host's root Stop, which
 * also keeps their results for the next user turn rather than waking the root.
 * While the root runs, its own Stop already ends that turn's children, so only
 * the children of earlier turns are stopped here.
 */
export function HostChildrenRunning({
  client,
  tree,
}: {
  readonly client: Pick<HostClient, 'request'>;
  readonly tree: Pick<HostTreeApprovals, 'getRunning' | 'subscribe' | 'threadId'>;
}): ReactElement | null {
  const running = useSyncExternalStore(tree.subscribe, tree.getRunning, tree.getRunning);
  const owners = useMemo(() => running.children.map((child) => child.owner), [running]);
  const earlier = useMemo(
    () => running.children.filter((child) => child.turnId !== running.activeTurnId),
    [running]
  );
  const stoppable = useMemo(() => earlier.map((child) => child.owner), [earlier]);
  const stop = useCallback(
    () =>
      stopHostChildTurns(client, tree.threadId, earlier).catch((cause: unknown) => {
        logger.error('Background subagents could not be stopped', {
          error: cause,
          threadId: tree.threadId,
        });
        throw new Error(describeBoundaryError(cause));
      }),
    [client, earlier, tree.threadId]
  );
  return <SubagentsRunningStrip onStop={stop} owners={owners} stoppable={stoppable} />;
}

/**
 * BST-1932 (AT-08): the questions and plans waiting in threads delegated
 * beneath a host thread, owner-named at its composer, as the shipped root was
 * told a child waited. Each is answered in its own child, which this opens.
 */
export function HostChildWaiting({
  tree,
}: {
  readonly tree: Pick<HostTreeApprovals, 'getInteractions' | 'subscribe'>;
}): ReactElement | null {
  const waiting = useSyncExternalStore(tree.subscribe, tree.getInteractions, tree.getInteractions);
  if (waiting.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Waiting in delegated conversations" className="space-y-1 px-2 py-1 text-xs">
      {waiting.map(({ interaction, owner, persona, threadId }) => (
        <li
          className="flex items-center justify-between gap-2"
          data-kind={interaction.kind}
          data-testid="host-child-waiting"
          key={interaction.interactionId}
        >
          <span>
            {interaction.kind === 'plan'
              ? `${owner} proposes a plan`
              : `${owner} asks you a question`}
          </span>
          <Button
            className="h-6 text-xs"
            onClick={() => openHostChildTab({ persona, threadId })}
            size="sm"
            variant="ghost"
          >
            Answer in {owner}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * BST-1932 (AT-07): each delegation card's history, the answered approvals of
 * its own child, read from the tree the root already follows.
 */
export function HostApprovalHistoryProvider({
  children,
  tree,
}: {
  readonly children: ReactNode;
  readonly tree: Pick<HostTreeApprovals, 'getAnswered' | 'subscribe'>;
}): ReactElement {
  const answered = useSyncExternalStore(tree.subscribe, tree.getAnswered, tree.getAnswered);
  const history = useMemo(() => {
    const byThread = new Map<string, SubagentAnsweredApproval[]>();
    for (const { approval, byPolicy, decision, owner, threadId } of answered) {
      const entries = byThread.get(threadId) ?? [];
      entries.push({
        args: approval.input,
        byPolicy,
        decision,
        interactionId: approval.interactionId,
        owner,
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolCatalogId ?? approval.toolId,
      });
      byThread.set(threadId, entries);
    }
    return (threadId: string): readonly SubagentAnsweredApproval[] =>
      byThread.get(threadId) ?? NO_HISTORY;
  }, [answered]);
  return (
    <SubagentApprovalHistoryContext value={history}>{children}</SubagentApprovalHistoryContext>
  );
}
