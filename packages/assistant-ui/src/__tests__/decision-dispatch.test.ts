/**
 * A decision during a run queues behind the running turn, and appends at once
 * when nothing runs. Never a cancel.
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

  it('queues behind the running turn', async () => {
    const append = vi.fn();
    await expect(
      submitDecisionOrQueue({
        append,
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

  it('appends at once when nothing runs', async () => {
    const append = vi.fn();
    await expect(
      submitDecisionOrQueue({
        append,
        identityKey: 'k',
        isRunning: false,
        message,
        text: 'Approved read.',
        threadKey: 'root',
      })
    ).resolves.toBe('sent');
    expect(append).toHaveBeenCalledExactlyOnceWith(message);
  });
});
