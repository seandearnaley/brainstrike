import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import { restoreDelegatedConversationHistory } from '@brainstrike/assistant-data';
import type { DelegatedConversationUpdate } from '@brainstrike/assistant-ui';

export interface DelegatedConversationSnapshot {
  readonly history: Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
  readonly update: DelegatedConversationUpdate;
}
export interface DelegatedConversationStore {
  clear(): void;
  getConversation(threadId: string): DelegatedConversationSnapshot | undefined;
  getSnapshot(): ReadonlyMap<string, DelegatedConversationSnapshot>;
  /** Every accepted host publication is activity; identical text is still a new event. */
  hasUnread(threadId: string): boolean;
  invalidate(threadId: string): void;
  markRead(threadId: string): void;
  publish(update: DelegatedConversationUpdate): boolean;
  readonly rootThreadId: string;
  subscribe(listener: () => void): () => void;
}
const identityKey = (update: DelegatedConversationUpdate): string =>
  update.continuation
    ? JSON.stringify(['continuation', update.continuation.continuationId])
    : JSON.stringify([
        'delegation',
        update.identity.parentRuntimeRunId,
        update.identity.parentToolCallId,
        update.identity.childRuntimeRunId,
        update.identity.personaId,
        update.continuationId,
      ]);

function assertStableBinding(
  update: DelegatedConversationUpdate,
  previous: DelegatedConversationSnapshot | undefined,
  bound: { readonly threadId: string; readonly nativeRunId: string } | undefined,
  key: string,
  threadId: string,
  hostRunId: string,
  nativeRunId: string
): void {
  if (bound && (bound.threadId !== threadId || bound.nativeRunId !== nativeRunId)) {
    throw new Error('Delegated conversation identity changed.');
  }
  if (!previous || identityKey(previous.update) === key) {
    return;
  }
  if (
    !(update.continuation || update.continuationId) ||
    previous.update.baseline?.hostRunId === hostRunId
  ) {
    throw new Error('Delegated conversation identity changed.');
  }
}

/** Ephemeral host state: closing a view neither discards output nor cancels work. */
export function createDelegatedConversationStore(rootThreadId: string): DelegatedConversationStore {
  if (!rootThreadId.trim()) {
    throw new Error('A delegated store requires its root thread.');
  }
  let values = new Map<string, DelegatedConversationSnapshot>();
  const seen = new Map<string, DelegatedConversationSnapshot>();
  const retiredLegs = new Map<string, Set<string>>();
  const threadByInvocation = new Map<
    string,
    { readonly threadId: string; readonly nativeRunId: string }
  >();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    clear: () => {
      values = new Map();
      seen.clear();
      retiredLegs.clear();
      threadByInvocation.clear();
      notify();
    },
    getConversation: (threadId) => values.get(threadId),
    getSnapshot: () => values,
    hasUnread: (threadId) => values.has(threadId) && values.get(threadId) !== seen.get(threadId),
    invalidate(threadId) {
      const snapshot = values.get(threadId);
      if (!snapshot) {
        return;
      }
      const hostRunId = snapshot.update.baseline?.hostRunId;
      if (hostRunId) {
        const retired = retiredLegs.get(threadId) ?? new Set<string>();
        retired.add(hostRunId);
        retiredLegs.set(threadId, retired);
      }
      values = new Map(values);
      values.delete(threadId);
      seen.delete(threadId);
      notify();
    },
    markRead: (threadId) => {
      const snapshot = values.get(threadId);
      if (!snapshot || seen.get(threadId) === snapshot) {
        return;
      }
      seen.set(threadId, snapshot);
      notify();
    },
    publish: (update) => {
      const baseline = update.baseline;
      if (!baseline) {
        throw new Error('A delegated conversation requires its history baseline.');
      }
      if (baseline.threadId === rootThreadId) {
        throw new Error('A child cannot replace its root conversation.');
      }
      if (update.continuation && update.continuation.threadId !== baseline.threadId) {
        throw new Error('Child continuation history belongs to another thread.');
      }
      const previous = values.get(baseline.threadId);
      const key = identityKey(update);
      const bound = threadByInvocation.get(key);
      const nativeRunId = update.continuation
        ? update.continuation.nativeRunId
        : update.identity.childRuntimeRunId;
      const retired = retiredLegs.get(baseline.threadId) ?? new Set<string>();
      // A prior invocation may finish after a fresh continuation was admitted.
      if (retired.has(baseline.hostRunId)) {
        return false;
      }
      assertStableBinding(
        update,
        previous,
        bound,
        key,
        baseline.threadId,
        baseline.hostRunId,
        nativeRunId
      );
      const history =
        previous?.update.baseline === baseline
          ? previous.history
          : restoreDelegatedConversationHistory(baseline);
      const previousHost = previous?.update.baseline?.hostRunId;
      if (previousHost && previousHost !== baseline.hostRunId) {
        retired.add(previousHost);
      }
      retiredLegs.set(baseline.threadId, retired);
      threadByInvocation.set(key, { nativeRunId, threadId: baseline.threadId });
      values = new Map(values).set(baseline.threadId, { history, update });
      notify();
      return true;
    },
    rootThreadId,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
