/**
 * A decision during a run reaches the RUNNING turn when the host offers a
 * live transport (desktop POST /assistant/decide); it queues only when no leg
 * is live for it, and appends at once when nothing runs. Never a cancel.
 */
import type { CreateAppendMessage } from '@assistant-ui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitDecisionOrQueue } from '../decision-dispatch';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';

const message = {
  content: [{ text: 'Approved read.', type: 'text' }],
  role: 'user',
  startRun: true,
} satisfies CreateAppendMessage;

const queued = () => useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root')];

describe('submitDecisionOrQueue', () => {
  beforeEach(() => {
    resetFollowUpQueueStore();
  });

  it('delivers into the running turn and never appends or queues', async () => {
    const append = vi.fn();
    const deliverLive = vi.fn(async () => 'delivered' as const);
    await expect(
      submitDecisionOrQueue({
        append,
        deliverLive,
        identityKey: 'k',
        isRunning: true,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).resolves.toBe('delivered');
    expect(deliverLive).toHaveBeenCalledExactlyOnceWith(message);
    expect(append).not.toHaveBeenCalled();
    expect(queued()).toBeUndefined();
  });

  it('queues when no leg is live for the decision, and without a transport', async () => {
    const append = vi.fn();
    await expect(
      submitDecisionOrQueue({
        append,
        deliverLive: async () => 'no-live-run' as const,
        identityKey: 'k1',
        isRunning: true,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).resolves.toBe('queued');
    await expect(
      submitDecisionOrQueue({
        append,
        deliverLive: null,
        identityKey: 'k2',
        isRunning: true,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).resolves.toBe('queued');
    expect(append).not.toHaveBeenCalled();
    expect(queued()?.map((item) => item.identityKey)).toEqual(['k1', 'k2']);
  });

  it('appends at once when nothing runs, without touching the transport', async () => {
    const append = vi.fn();
    const deliverLive = vi.fn(async () => 'delivered' as const);
    await expect(
      submitDecisionOrQueue({
        append,
        deliverLive,
        identityKey: 'k',
        isRunning: false,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).resolves.toBe('sent');
    expect(append).toHaveBeenCalledExactlyOnceWith(message);
    expect(deliverLive).not.toHaveBeenCalled();
  });

  it('propagates a transport failure (host refusal) instead of queueing a refused decision', async () => {
    const append = vi.fn();
    await expect(
      submitDecisionOrQueue({
        append,
        deliverLive: async () => {
          throw new Error('The decision was not applied: already answered');
        },
        identityKey: 'k',
        isRunning: true,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).rejects.toThrow(/already answered/);
    expect(append).not.toHaveBeenCalled();
    expect(queued()).toBeUndefined();
  });
});
