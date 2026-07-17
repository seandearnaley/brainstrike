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
import { create } from 'zustand';

export interface FollowUpQueueItem {
  readonly id: string;
  readonly text: string;
}

interface FollowUpQueueState {
  clearThread: (threadKey: string) => void;
  dequeue: (threadKey: string) => FollowUpQueueItem | undefined;
  enqueue: (threadKey: string, text: string) => void;
  queuedByThread: Record<string, readonly FollowUpQueueItem[]>;
  remove: (threadKey: string, itemId: string) => void;
  /** Put a failed dispatch back at the FRONT so retry preserves user order. */
  requeueFront: (threadKey: string, item: FollowUpQueueItem) => void;
}

/** Panels without a thread key share one sentinel queue (never the '' key). */
export function followUpQueueKey(threadKey: string | undefined): string {
  return threadKey ?? '__no-thread__';
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

/** Clears all queues (factory reset / test isolation). */
export function resetFollowUpQueueStore(): void {
  useFollowUpQueueStore.setState({ queuedByThread: {} });
}
