import type { HostClient } from '@brainstrike/agent-host/browser';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantThreadContextSnapshot,
  AssistantThreadContextSource,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { ThreadContextReader } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { committedConversationIdentity } from './committed-host-conversation';

const logger = createLogger('HostThreadContext');

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * BST-2021: a thread's committed log, folded as its own view folds it, for a
 * subagent's lane in its parent's Context tab. It is its own subscription: the
 * host counts one per view, so an open tab of the same thread keeps reading
 * when this one closes.
 */
export function openHostThreadContext(
  client: Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry' | 'request'>,
  threadId: string
): AssistantThreadContextSource {
  const session = new CommittedThreadSession(client, threadId);
  const reader = new ThreadContextReader({
    identifyRun: (row) => committedConversationIdentity(session.getSnapshot().rows, row),
    threadId,
  });
  const read = (): AssistantThreadContextSnapshot => {
    const { connected, error, isLoading, replayedThrough, rows } = session.getSnapshot();
    const failure = error ?? (connected ? undefined : 'The agent host connection closed.');
    const state = { ...(failure ? { error: failure } : {}), isLoading };
    // No map before the replay is read: a refused subscription is not an empty thread.
    if (replayedThrough === undefined) {
      return state;
    }
    try {
      return { ...state, record: reader.accept(rows) };
    } catch (cause) {
      return { error: `The thread's log could not be read: ${describe(cause)}`, isLoading };
    }
  };
  const listeners = new Set<() => void>();
  let snapshot = read();
  const release = session.subscribe(() => {
    const next = read();
    if (
      next.error === snapshot.error &&
      next.isLoading === snapshot.isLoading &&
      next.record === snapshot.record
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  });
  const disconnect = session.connect();
  return {
    close: () => {
      release();
      listeners.clear();
      // The client outlives this read, so the unsubscribe is not joined here;
      // its refusal is reported, never swallowed.
      disconnect().catch((error: unknown) => {
        logger.error('Thread context unsubscribe failed', { error, threadId });
      });
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
