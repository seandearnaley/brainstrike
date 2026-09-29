/**
 * Per-thread follow-up message queue (report R3 v1): messages the user types
 * WHILE a run is active, held as a visible, removable "queued" chip and
 * dispatched one per run end by `FollowUpQueueBridge` (see follow-up-queue.tsx).
 *
 * Session-lived, deliberately NOT persisted (a queued message that survives a
 * reload the user never saw sent would be a surprise send). Registered with
 * factory reset via app-shell's `register-factory-reset-session-stores.ts`,
 * mirroring `context-usage-store.ts`.
 */
import type { CreateAppendMessage } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { create } from 'zustand';

const logger = createLogger('FollowUpQueue');

export interface FollowUpQueueItem {
  readonly id: string;
  /**
   * A tool decision (approval / typed resume) submitted while a run was
   * active. Appending it immediately would CANCEL the in-flight run in the
   * installed assistant-ui runtime (2026-09-14, thread-b3cea1f6: the second
   * card's click aborted the first card's resume leg and was itself lost), so
   * it waits its turn like a typed follow-up. `identityKey` is the pause's
   * `getToolActionIdentityKey`, so its card can show "Queued" and re-enable
   * when the chip is removed.
   */
  readonly identityKey?: string;
  readonly message?: CreateAppendMessage;
  readonly text: string;
}

interface FollowUpQueueState {
  clearThread: (threadKey: string) => void;
  dequeue: (threadKey: string) => FollowUpQueueItem | undefined;
  enqueue: (threadKey: string, text: string) => void;
  /** Steer messages jump the queue (BST-588); same non-whitespace contract. */
  enqueueFront: (threadKey: string, text: string) => void;
  /** Queue a decision message (see `FollowUpQueueItem.message`). */
  enqueueMessage: (
    threadKey: string,
    item: {
      readonly identityKey: string;
      readonly message: CreateAppendMessage;
      readonly text: string;
    }
  ) => void;
  queuedByThread: Record<string, readonly FollowUpQueueItem[]>;
  remove: (threadKey: string, itemId: string) => void;
  /** Put a failed dispatch back at the FRONT so retry preserves user order. */
  requeueFront: (threadKey: string, item: FollowUpQueueItem) => void;
}

/** Panels without a thread key share one sentinel queue (never the '' key). */
export function followUpQueueKey(threadKey: string | undefined): string {
  return threadKey ?? '__no-thread__';
}

/** Whether a decision with this identity key is waiting in the thread's queue. */
export function isDecisionQueued(
  state: Pick<FollowUpQueueState, 'queuedByThread'>,
  threadKey: string,
  identityKey: string
): boolean {
  return (state.queuedByThread[threadKey] ?? []).some((item) => item.identityKey === identityKey);
}

export const useFollowUpQueueStore = create<FollowUpQueueState>((set, get) => ({
  clearThread: (threadKey) =>
    set((state) => {
      const { [threadKey]: _removed, ...rest } = state.queuedByThread;
      return { queuedByThread: rest };
    }),
  dequeue: (threadKey) => {
    const queue = get().queuedByThread[threadKey];
    const head = queue?.[0];
    if (!head) {
      return;
    }
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: (state.queuedByThread[threadKey] ?? []).slice(1),
      },
    }));
    return head;
  },
  enqueue: (threadKey, text) => {
    if (!text.trim()) {
      throw new Error('Follow-up messages require non-whitespace text.');
    }
    const item: FollowUpQueueItem = { id: crypto.randomUUID(), text };
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: [...(state.queuedByThread[threadKey] ?? []), item],
      },
    }));
  },
  enqueueFront: (threadKey, text) => {
    if (!text.trim()) {
      throw new Error('Follow-up messages require non-whitespace text.');
    }
    // Steer messages (BST-588) jump the queue: the user interrupted the run
    // FOR this message, so it must dispatch before earlier passive follow-ups.
    const item: FollowUpQueueItem = { id: crypto.randomUUID(), text };
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: [item, ...(state.queuedByThread[threadKey] ?? [])],
      },
    }));
  },
  enqueueMessage: (threadKey, input) => {
    if (!input.text.trim()) {
      throw new Error('Queued decisions require non-whitespace text.');
    }
    const item: FollowUpQueueItem = { id: crypto.randomUUID(), ...input };
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: [...(state.queuedByThread[threadKey] ?? []), item],
      },
    }));
  },
  queuedByThread: {},
  remove: (threadKey, itemId) =>
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: (state.queuedByThread[threadKey] ?? []).filter((item) => item.id !== itemId),
      },
    })),
  requeueFront: (threadKey, item) =>
    set((state) => ({
      queuedByThread: {
        ...state.queuedByThread,
        [threadKey]: [item, ...(state.queuedByThread[threadKey] ?? [])],
      },
    })),
}));

/**
 * Dequeue the next item that still needs sending. A queued DECISION whose
 * pause the host has meanwhile answered (a session grant on a sibling card
 * answered it by policy; `answered-approvals-index.tsx`) is dropped with a
 * log line instead of dispatched: sending it would resume a consumed
 * decision and fail the run visibly for nothing (2026-09-14 multi-approval
 * audit). Typed follow-ups carry no identity and are never dropped.
 */
export function dequeueDispatchable(
  queueKey: string,
  answered: ReadonlyMap<string, unknown>
): FollowUpQueueItem | undefined {
  const store = useFollowUpQueueStore.getState();
  let item = store.dequeue(queueKey);
  while (item?.identityKey !== undefined && answered.has(item.identityKey)) {
    logger.info('Dropped a queued decision the host already answered', {
      code: 'follow_up_queue_decision_answered',
      identityKey: item.identityKey,
      text: item.text,
    });
    item = store.dequeue(queueKey);
  }
  return item;
}

/** Clears all queues (factory reset / test isolation). */
export function resetFollowUpQueueStore(): void {
  useFollowUpQueueStore.setState({ queuedByThread: {} });
}
