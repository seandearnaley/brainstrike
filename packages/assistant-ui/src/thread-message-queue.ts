/**
 * Per-thread message queue: assistant-ui's own `createMessageQueue`, kept one
 * per thread for the session so a queued message survives a thread switch
 * (the conversation subtree is keyed by thread and unmounts). The committed
 * runtime binds it while its thread is on screen (`useCommittedMessageQueue`).
 *
 * The vendor queue owns order, lanes (steer before queue), dispatch, restore
 * on a refused send, and the pause after a user cancel. This module adds what
 * the host needs around it:
 *  - run edges from the committed store, never a rendered `isRunning`: a run
 *    that starts and ends between two renders still advances the queue
 *    (BST-2207);
 *  - a hold while the thread is off screen, loading its replay or
 *    disconnected, because an idle-looking view is not a committed run end;
 *  - the identity of each queued tool decision, so its card shows "Queued"
 *    and a decision the host answered meanwhile is dropped instead of sent.
 *
 * Session-lived, deliberately NOT persisted: a queued message that survives a
 * reload the user never saw sent would be a surprise send. Factory reset
 * clears every queue (`register-factory-reset-session-stores.ts`).
 */
import {
  type AppendMessage,
  createMessageQueue,
  type ExternalThreadQueueAdapter,
  type MessageQueueController,
  type QueueItemState,
} from '@assistant-ui/react';
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import {
  isAssistantToolApprovalAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isAssistantToolResumeAction,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useSyncExternalStore } from 'react';

const logger = createLogger('FollowUpQueue');

const EMPTY_KEYS: ReadonlySet<string> = new Set();

interface QueuedMessage {
  /** `getToolActionIdentityKey` of a queued tool decision; absent for typed text. */
  readonly identityKey: string | undefined;
  readonly message: AppendMessage;
}

/** The pause a decision message answers, read from its bookkeeping metadata. */
function decisionIdentityKey(message: AppendMessage): string | undefined {
  const custom = message.metadata?.custom;
  const approval = custom?.[TOOL_APPROVAL_RUN_CONFIG_KEY];
  if (isAssistantToolApprovalAction(approval)) {
    return getToolActionIdentityKey(approval);
  }
  const resume = custom?.[TOOL_SUSPEND_RUN_CONFIG_KEY];
  return isAssistantToolResumeAction(resume) ? getToolActionIdentityKey(resume) : undefined;
}

export class ThreadMessageQueue {
  /** Handed to the vendor runtime as its `queue`. */
  readonly adapter: ExternalThreadQueueAdapter;
  private readonly controller: MessageQueueController;
  private readonly queued = new Map<string, QueuedMessage>();
  private send: ((message: AppendMessage) => Promise<void>) | undefined;
  private reportedRunning = false;
  private items: readonly QueueItemState[] = [];
  private decisionKeys: ReadonlySet<string> = EMPTY_KEYS;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.controller = createMessageQueue({
      run: (message) => {
        if (!this.send) {
          // Unreachable while held; a throw restores the item and pauses.
          throw new Error('The queued message has no conversation to send it.');
        }
        // A refused send rejects and the vendor puts the same item back, so
        // bookkeeping for a dispatched item is dropped only once it was sent.
        return this.send(message).then(() => this.prune());
      },
    });
    // Held until a mounted conversation binds it with a settled, connected view.
    this.controller.hold();
    const inner = this.controller.adapter;
    const track =
      (push: (message: AppendMessage) => void) =>
      (message: AppendMessage): void => {
        const before = new Set(this.items.map((item) => item.id));
        push(message);
        // An idle queue dispatches synchronously; only an item still waiting is tracked.
        const added = this.lanes().find((item) => !before.has(item.id));
        if (added) {
          this.queued.set(added.id, { identityKey: decisionIdentityKey(message), message });
          this.changed();
        }
      };
    this.adapter = {
      // biome-ignore lint/style/useNamingConvention: installed assistant-ui queue adapter port name.
      __internal_notifyCancelled: inner.__internal_notifyCancelled,
      // biome-ignore lint/style/useNamingConvention: installed assistant-ui queue adapter port name.
      __internal_setDispatchTransform: inner.__internal_setDispatchTransform,
      edit: inner.edit,
      enqueue: track(inner.enqueue),
      get items() {
        return inner.items;
      },
      move: inner.move,
      remove: (itemId: string): void => {
        inner.remove(itemId);
        this.queued.delete(itemId);
        this.changed();
      },
      steer: track(inner.steer),
      get steerItems() {
        return inner.steerItems;
      },
    };
    this.controller.subscribe(() => this.changed());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Every waiting message in send order: the steer lane, then the queue. */
  readonly getItems = (): readonly QueueItemState[] => this.items;

  readonly getDecisionKeys = (): ReadonlySet<string> => this.decisionKeys;

  isDecision(itemId: string): boolean {
    return this.queued.get(itemId)?.identityKey !== undefined;
  }

  /**
   * Bind the mounted conversation's send port. The queue stays held until the
   * view reports a settled, connected snapshot through `observe`.
   */
  bind(send: (message: AppendMessage) => Promise<void>): () => void {
    this.send = send;
    return () => {
      if (this.send === send) {
        this.send = undefined;
        this.controller.hold();
      }
    };
  }

  /**
   * One committed observation. `settled` is false while the replay loads or
   * the owner is disconnected: the queue holds and no edge is read from it.
   * `catchUp` marks the first settled observation after a bind: an idle
   * thread then counts as the run end this queue missed while unmounted.
   */
  observe({
    catchUp,
    running,
    settled,
  }: {
    readonly catchUp: boolean;
    readonly running: boolean;
    readonly settled: boolean;
  }): void {
    if (!settled) {
      this.controller.hold();
      return;
    }
    if (running !== this.reportedRunning || (catchUp && !running)) {
      this.reportedRunning = running;
      if (running) {
        this.controller.notifyBusy();
      } else {
        this.controller.notifyIdle();
      }
    }
    if (this.send) {
      this.controller.release();
    }
  }

  /**
   * Send a waiting item now when no run is active: the queue pauses after a
   * user cancel or a refused send, and the next send re-arms it. The item
   * goes to the front so it is the one sent.
   */
  sendNow(itemId: string): void {
    const item = this.queued.get(itemId);
    if (!item) {
      return;
    }
    this.adapter.remove(itemId);
    this.adapter.steer(item.message);
  }

  /** Drop queued decisions whose pause the host already answered. */
  dropAnswered(answered: ReadonlyMap<string, unknown>): void {
    for (const [itemId, item] of this.queued) {
      if (item.identityKey !== undefined && answered.has(item.identityKey)) {
        logger.info('Dropped a queued decision the host already answered', {
          code: 'follow_up_queue_decision_answered',
          identityKey: item.identityKey,
        });
        this.adapter.remove(itemId);
      }
    }
  }

  clear(): void {
    this.controller.clear();
    this.queued.clear();
    this.changed();
  }

  private lanes(): readonly QueueItemState[] {
    const { items, steerItems } = this.controller.adapter;
    return steerItems.length === 0 ? items : [...steerItems, ...items];
  }

  /** Forget items that left both lanes: sent, or cleared by the vendor. */
  private prune(): void {
    const ids = new Set(this.lanes().map((item) => item.id));
    for (const itemId of this.queued.keys()) {
      if (!ids.has(itemId)) {
        this.queued.delete(itemId);
      }
    }
    this.changed();
  }

  private changed(): void {
    const items = this.lanes();
    const keys = new Set<string>();
    for (const item of this.queued.values()) {
      if (item.identityKey !== undefined) {
        keys.add(item.identityKey);
      }
    }
    if (!sameItems(items, this.items)) {
      this.items = items;
    }
    if (!sameKeys(keys, this.decisionKeys)) {
      this.decisionKeys = keys.size === 0 ? EMPTY_KEYS : keys;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sameItems(a: readonly QueueItemState[], b: readonly QueueItemState[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

const queues = new Map<string, ThreadMessageQueue>();
const registryListeners = new Set<() => void>();

function registryChanged(): void {
  for (const listener of registryListeners) {
    listener();
  }
}

/** The thread's queue, created on first use and kept for the session. */
export function threadMessageQueue(threadKey: string): ThreadMessageQueue {
  let queue = queues.get(threadKey);
  if (!queue) {
    queue = new ThreadMessageQueue();
    queues.set(threadKey, queue);
    registryChanged();
  }
  return queue;
}

/** The thread's queue if its conversation has created one; readers never create it. */
export function findThreadMessageQueue(
  threadKey: string | undefined
): ThreadMessageQueue | undefined {
  return threadKey === undefined ? undefined : queues.get(threadKey);
}

/** Clears every queue (factory reset / test isolation). */
export function resetThreadMessageQueues(): void {
  for (const queue of queues.values()) {
    queue.clear();
  }
  queues.clear();
  registryChanged();
}

/** The identity keys of the tool decisions waiting in a thread's queue. */
export function useQueuedDecisionKeys(threadKey: string | undefined): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      let unsubscribe = findThreadMessageQueue(threadKey)?.subscribe(listener);
      const rebind = (): void => {
        unsubscribe?.();
        unsubscribe = findThreadMessageQueue(threadKey)?.subscribe(listener);
        listener();
      };
      registryListeners.add(rebind);
      return () => {
        registryListeners.delete(rebind);
        unsubscribe?.();
      };
    },
    [threadKey]
  );
  const getKeys = (): ReadonlySet<string> =>
    findThreadMessageQueue(threadKey)?.getDecisionKeys() ?? EMPTY_KEYS;
  return useSyncExternalStore(subscribe, getKeys, getKeys);
}
