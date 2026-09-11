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
  markRead(threadId: string): void;
  publish(update: DelegatedConversationUpdate): boolean;
  readonly rootThreadId: string;
  subscribe(listener: () => void): () => void;
}
const identityKey = ({ identity }: DelegatedConversationUpdate): string =>
  JSON.stringify([
    identity.parentRuntimeRunId,
    identity.parentToolCallId,
    identity.childRuntimeRunId,
    identity.personaId,
  ]);

/** Ephemeral host state: closing a view neither discards output nor cancels work. */
export function createDelegatedConversationStore(rootThreadId: string): DelegatedConversationStore {
  if (!rootThreadId.trim()) {
    throw new Error('A delegated store requires its root thread.');
  }
  let values = new Map<string, DelegatedConversationSnapshot>();
  const seen = new Map<string, DelegatedConversationSnapshot>();
  const retiredLegs = new Map<string, Set<string>>();
  const threadByInvocation = new Map<string, string>();
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
      const previous = values.get(baseline.threadId);
      const key = identityKey(update);
      const boundThread = threadByInvocation.get(key);
      if (
        (previous && identityKey(previous.update) !== key) ||
        (boundThread && boundThread !== baseline.threadId)
      ) {
        throw new Error('Delegated conversation identity changed.');
      }
      const retired = retiredLegs.get(baseline.threadId) ?? new Set<string>();
      // Reconnection replays the current leg as complete snapshots. A callback
      // from a superseded leg cannot replace a newer admitted continuation.
      if (retired.has(baseline.hostRunId)) {
        return false;
      }
      const history =
        previous?.update.baseline === baseline
          ? previous.history
          : restoreDelegatedConversationHistory(baseline);
      const previousHost = previous?.update.baseline?.hostRunId;
      if (previousHost && previousHost !== baseline.hostRunId) {
        retired.add(previousHost);
      }
      retiredLegs.set(baseline.threadId, retired);
      threadByInvocation.set(key, baseline.threadId);
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
