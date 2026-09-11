import { describe, expect, it, vi } from 'vitest';
import { createDelegatedConversationStore } from '../delegated-conversation-store';
import { delegatedUpdate as update } from './helpers/delegated-conversation-fixtures';

describe('host-owned delegated conversations', () => {
  it('retains independent child snapshots after every view unsubscribes and publishes replay as replacement', () => {
    const store = createDelegatedConversationStore('root');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.publish(update('a'))).toBe(true);
    const first = store.getConversation('a');
    store.publish(update('b'));
    expect(store.getConversation('a')).toBe(first);
    expect(store.getConversation('b')?.update.message.parts).toMatchObject([{ text: 'b' }]);
    unsubscribe();
    store.publish(update('a', 'initial', 'Later full snapshot'));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getConversation('a')?.update.message.parts).toMatchObject([
      { text: 'Later full snapshot' },
    ]);
    expect(store.getConversation('a')?.history.messages[0]?.message.content).toEqual([
      { text: 'Inspect the workspace', type: 'text' },
    ]);
  });

  it('keeps read receipts with the host when a virtual sidebar row unmounts', () => {
    const store = createDelegatedConversationStore('root');
    store.publish(update('a'));
    expect(store.hasUnread('a')).toBe(true);
    const stop = store.subscribe(() => undefined);
    store.markRead('a');
    stop();
    expect(store.hasUnread('a')).toBe(false);
    store.publish(update('b'));
    expect(store.hasUnread('a')).toBe(false);
    expect(store.hasUnread('b')).toBe(true);
    store.publish(update('a', 'initial', 'New activity'));
    expect(store.hasUnread('a')).toBe(true);
    store.clear();
    expect(store.hasUnread('a')).toBe(false);
  });

  it('ignores an old host leg after a new leg has replaced it, without discarding the new history', () => {
    const store = createDelegatedConversationStore('root');
    store.publish(update('a'));
    store.publish(update('a', 'resumed', 'Resumed answer'));
    const resumed = store.getConversation('a');
    expect(resumed?.update.message.parts).toMatchObject([{ text: 'Resumed answer' }]);
    expect(store.publish(update('a', 'initial', 'Late old callback'))).toBe(false);
    expect(store.getConversation('a')).toBe(resumed);
  });

  it('rejects missing history, a root masquerading as a child, and changed invocation identity', () => {
    const store = createDelegatedConversationStore('root');
    const { baseline: _baseline, ...missing } = update('a');
    expect(() => store.publish(missing)).toThrow(/baseline/i);
    expect(() => store.publish(update('root'))).toThrow(/root/i);
    store.publish(update('a'));
    const changed = update('a');
    expect(() =>
      store.publish({
        ...changed,
        identity: { ...changed.identity, parentToolCallId: 'other-call' },
      })
    ).toThrow(/identity/i);
  });
});
