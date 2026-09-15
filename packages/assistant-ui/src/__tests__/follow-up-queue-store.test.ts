/**
 * Unit coverage for the follow-up queue store (report R3 v1): per-thread FIFO
 * of messages typed DURING an active run, dispatched one per run end by
 * FollowUpQueueBridge (behavior proved in follow-up-queue.behavior.test.tsx).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dequeueDispatchable } from '../follow-up-queue';
import {
  followUpQueueKey,
  isDecisionQueued,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';

describe('follow-up queue store', () => {
  beforeEach(() => {
    resetFollowUpQueueStore();
  });

  it('derives a stable key, with a sentinel for missing thread keys', () => {
    expect(followUpQueueKey('thread-1')).toBe('thread-1');
    expect(followUpQueueKey(undefined)).toBe(followUpQueueKey(undefined));
    expect(followUpQueueKey(undefined)).not.toBe('');
  });

  it('enqueueFront places a steer message ahead of already-queued follow-ups (BST-588)', () => {
    const { enqueue, enqueueFront, dequeue } = useFollowUpQueueStore.getState();
    enqueue('thread-1', 'queued follow-up');
    enqueueFront('thread-1', 'steer message');

    expect(dequeue('thread-1')?.text).toBe('steer message');
    expect(dequeue('thread-1')?.text).toBe('queued follow-up');
  });

  it('enqueueFront refuses whitespace-only text like enqueue (BST-588)', () => {
    const { enqueueFront } = useFollowUpQueueStore.getState();
    expect(() => enqueueFront('thread-1', '   ')).toThrow(/non-whitespace/i);
  });

  it('enqueues FIFO per thread and dequeues in order', () => {
    const { enqueue, dequeue } = useFollowUpQueueStore.getState();
    enqueue('t1', 'first');
    enqueue('t1', 'second');

    expect(useFollowUpQueueStore.getState().queuedByThread['t1']).toHaveLength(2);
    expect(useFollowUpQueueStore.getState().dequeue('t1')?.text).toBe('first');
    expect(useFollowUpQueueStore.getState().dequeue('t1')?.text).toBe('second');
    expect(useFollowUpQueueStore.getState().dequeue('t1')).toBeUndefined();
    // Silence unused warnings for destructured initial getters.
    expect(typeof dequeue).toBe('function');
  });

  it('isolates queues by thread', () => {
    useFollowUpQueueStore.getState().enqueue('t1', 'for t1');
    expect(useFollowUpQueueStore.getState().queuedByThread['t2']).toBeUndefined();
    expect(useFollowUpQueueStore.getState().dequeue('t2')).toBeUndefined();
    expect(useFollowUpQueueStore.getState().dequeue('t1')?.text).toBe('for t1');
  });

  it('refuses whitespace-only text (no silent empty sends later)', () => {
    expect(() => useFollowUpQueueStore.getState().enqueue('t1', '   \n')).toThrow(
      /non-whitespace/i
    );
  });

  it('removes a single queued item by id', () => {
    useFollowUpQueueStore.getState().enqueue('t1', 'keep');
    useFollowUpQueueStore.getState().enqueue('t1', 'drop');
    const dropId = useFollowUpQueueStore.getState().queuedByThread['t1']?.[1]?.id;
    expect(dropId).toBeDefined();

    useFollowUpQueueStore.getState().remove('t1', dropId ?? '');
    const remaining = useFollowUpQueueStore.getState().queuedByThread['t1'];
    expect(remaining?.map((item) => item.text)).toEqual(['keep']);
  });

  it('requeues a failed dispatch at the FRONT (retry keeps user order)', () => {
    useFollowUpQueueStore.getState().enqueue('t1', 'first');
    useFollowUpQueueStore.getState().enqueue('t1', 'second');
    const item = useFollowUpQueueStore.getState().dequeue('t1');
    expect(item?.text).toBe('first');

    if (item) {
      useFollowUpQueueStore.getState().requeueFront('t1', item);
    }
    expect(
      useFollowUpQueueStore.getState().queuedByThread['t1']?.map((entry) => entry.text)
    ).toEqual(['first', 'second']);
  });

  it('clears a whole thread queue', () => {
    useFollowUpQueueStore.getState().enqueue('t1', 'a');
    useFollowUpQueueStore.getState().enqueue('t2', 'b');
    useFollowUpQueueStore.getState().clearThread('t1');
    expect(useFollowUpQueueStore.getState().queuedByThread['t1']).toBeUndefined();
    expect(useFollowUpQueueStore.getState().queuedByThread['t2']).toHaveLength(1);
  });

  it('resets all queues (factory reset / test isolation)', () => {
    useFollowUpQueueStore.getState().enqueue('t1', 'a');
    resetFollowUpQueueStore();
    expect(useFollowUpQueueStore.getState().queuedByThread).toEqual({});
  });

  it('queues a decision message behind typed follow-ups and reports it by identity key', () => {
    const { enqueue, enqueueMessage, dequeue } = useFollowUpQueueStore.getState();
    enqueue('t1', 'typed first');
    const message = {
      content: [{ text: 'Approved brainstrike.grepSearch.', type: 'text' as const }],
      role: 'user' as const,
      runConfig: { custom: { brainstrikeToolApproval: { action: 'approve' } } },
      startRun: true,
    };
    enqueueMessage('t1', {
      identityKey: '["child-run","leaf-1"]',
      message,
      text: 'Approved brainstrike.grepSearch.',
    });
    expect(isDecisionQueued(useFollowUpQueueStore.getState(), 't1', '["child-run","leaf-1"]')).toBe(
      true
    );
    expect(isDecisionQueued(useFollowUpQueueStore.getState(), 't1', '["other","leaf"]')).toBe(
      false
    );
    expect(dequeue('t1')?.text).toBe('typed first');
    const decision = useFollowUpQueueStore.getState().dequeue('t1');
    expect(decision?.message).toBe(message);
    expect(isDecisionQueued(useFollowUpQueueStore.getState(), 't1', '["child-run","leaf-1"]')).toBe(
      false
    );
  });

  it('refuses a decision with no visible label', () => {
    expect(() =>
      useFollowUpQueueStore.getState().enqueueMessage('t1', {
        identityKey: 'k',
        message: { content: [], role: 'user' },
        text: '  ',
      })
    ).toThrow(/non-whitespace/i);
  });

  it('drops queued decisions the host already answered and dispatches the next item', () => {
    const { enqueue, enqueueMessage } = useFollowUpQueueStore.getState();
    const decision = (key: string) => ({
      identityKey: key,
      message: {
        content: [{ text: `Approved ${key}.`, type: 'text' as const }],
        role: 'user' as const,
      },
      text: `Approved ${key}.`,
    });
    enqueueMessage('t1', decision('answered-1'));
    enqueueMessage('t1', decision('answered-2'));
    enqueue('t1', 'typed follow-up');
    enqueueMessage('t1', decision('still-pending'));
    const answered = new Map([
      ['answered-1', 'session-grant'],
      ['answered-2', 'session-grant'],
    ]);
    expect(dequeueDispatchable('t1', answered)?.text).toBe('typed follow-up');
    expect(dequeueDispatchable('t1', answered)?.identityKey).toBe('still-pending');
    expect(dequeueDispatchable('t1', answered)).toBeUndefined();
  });
});
