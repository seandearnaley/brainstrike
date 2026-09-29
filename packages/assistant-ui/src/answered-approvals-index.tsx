import { useAuiState } from '@assistant-ui/react';
import { type ReactNode, use, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { AnsweredApprovalsContext } from './answered-approvals-context';
import {
  type AnsweredApprovalsIndex,
  advanceAnsweredApprovalsIndex,
  createMutableApprovalsIndex,
  EMPTY_ANSWERED_APPROVALS_INDEX,
  type MutableApprovalsIndex,
  type ScanCursor,
} from './answered-approvals-index-model';
import {
  ApprovalOwnerMessagesContext,
  type ApprovalOwnerThread,
  ApprovalOwnerThreadContext,
} from './approval-owner-thread-context';
import { ApprovalSubmissionProvider } from './approval-submission-provider';

/*
 * Mounts the thread's incremental approvals index over the thread. The fold
 * and its contract live in `answered-approvals-index-model.ts`; consumers read
 * it through `useAnsweredApprovals` (`answered-approvals-context.ts`). This
 * file exports only the provider so Fast Refresh keeps its boundary.
 */

interface IndexState {
  readonly cursor: ScanCursor;
  readonly index: MutableApprovalsIndex;
  readonly messages: readonly unknown[];
  readonly value: AnsweredApprovalsIndex;
}

function advanceIndexState(previous: IndexState, messages: readonly unknown[]): IndexState {
  const index: MutableApprovalsIndex = {
    answers: new Map(previous.index.answers),
    cardedSurfaceCalls: new Set(previous.index.cardedSurfaceCalls),
    prompts: new Map(previous.index.prompts),
    requests: new Map(previous.index.requests),
    userDecisions: new Map(previous.index.userDecisions),
  };
  const result = advanceAnsweredApprovalsIndex(messages, previous.cursor, index);
  return {
    cursor: result.cursor,
    index,
    messages,
    // An unchanged index keeps its identity so consumers do not re-render.
    value: result.changed
      ? {
          answers: index.answers,
          cardedSurfaceCalls: index.cardedSurfaceCalls,
          delegationPrompts: index.prompts,
          requests: index.requests,
          userDecisions: index.userDecisions,
        }
      : previous.value,
  };
}

const NO_MESSAGES: readonly unknown[] = [];

const INITIAL_STATE: IndexState = {
  cursor: { keys: [], scanned: [] },
  index: createMutableApprovalsIndex(),
  messages: NO_MESSAGES,
  value: EMPTY_ANSWERED_APPROVALS_INDEX,
};

// React's "store information from previous renders" pattern: the index is
// derived from the thread, advanced once per new messages array, and never
// an effect (no extra commit, no state used as an event handler).
function useIndexedMessages(messages: readonly unknown[]): AnsweredApprovalsIndex {
  const [state, setState] = useState<IndexState>(INITIAL_STATE);
  if (state.messages !== messages) {
    setState(advanceIndexState(state, messages));
  }
  return state.value;
}

function useOwnerMessages(owner: ApprovalOwnerThread | null): readonly unknown[] {
  const subscribe = useCallback(
    (listener: () => void) => (owner ? owner.subscribe(listener) : () => undefined),
    [owner]
  );
  const read = useCallback(() => (owner ? owner.getState().messages : NO_MESSAGES), [owner]);
  return useSyncExternalStore(subscribe, read, read);
}

export function AnsweredApprovalsProvider({ children }: { children: ReactNode }) {
  const messages = useAuiState((state) => state.thread.messages);
  const own = useIndexedMessages(messages);
  const ownerMessages = useOwnerMessages(use(ApprovalOwnerThreadContext));
  const ownerIndex = useIndexedMessages(ownerMessages);
  // Consumers re-render only when either index changes; a thread with no
  // owner (every root thread) folds in the empty index.
  const value = useMemo(
    () => ({
      ...own,
      answers: new Map([...ownerIndex.answers, ...own.answers]),
      userDecisions: new Map([...ownerIndex.userDecisions, ...own.userDecisions]),
    }),
    [own, ownerIndex]
  );
  return (
    <ApprovalOwnerMessagesContext value={ownerMessages}>
      <AnsweredApprovalsContext.Provider value={value}>
        <ApprovalSubmissionProvider>{children}</ApprovalSubmissionProvider>
      </AnsweredApprovalsContext.Provider>
    </ApprovalOwnerMessagesContext>
  );
}
