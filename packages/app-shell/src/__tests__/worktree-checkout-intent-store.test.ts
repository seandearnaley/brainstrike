import { beforeEach, describe, expect, it } from 'vitest';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';

const INTENT = {
  branch: 'bs/bright-fox',
  path: '/wt',
  threadId: 'thread-1',
  worktreeId: 'wt-1',
} as const;

describe('useWorktreeCheckoutIntentStore', () => {
  beforeEach(() => {
    useWorktreeCheckoutIntentStore.setState({ pending: null });
  });

  it('hands the intent to the matching thread exactly once', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')).toEqual(INTENT);
    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')).toBeNull();
    expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
  });

  it('does not hand a thread another thread’s intent, and does not clear it', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-2')).toBeNull();
    expect(useWorktreeCheckoutIntentStore.getState().pending).toEqual(INTENT);
  });

  it('replaces an unconsumed intent rather than queueing', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ ...INTENT, path: '/wt2', worktreeId: 'wt-2' });

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')?.worktreeId).toBe('wt-2');
  });
});
