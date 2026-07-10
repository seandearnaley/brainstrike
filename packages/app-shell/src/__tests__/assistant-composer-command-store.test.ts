import { beforeEach, describe, expect, it } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';

describe('assistant composer command store', () => {
  beforeEach(() => {
    useAssistantComposerCommandStore.getState().reset();
  });

  it('queues commands per thread in order and acknowledges only the matching command', () => {
    const first = useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: 'First snippet',
      threadId: 'thread-a',
    });
    const second = useAssistantComposerCommandStore.getState().enqueue({
      mode: 'replace',
      text: 'Full prompt',
      threadId: 'thread-a',
    });
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: 'Other thread',
      threadId: 'thread-b',
    });

    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-a']).toEqual([
      first,
      second,
    ]);
    useAssistantComposerCommandStore.getState().acknowledge('thread-a', 'not-the-command');
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-a']?.[0]).toEqual(
      first
    );

    useAssistantComposerCommandStore.getState().acknowledge('thread-a', first.id);
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-a']).toEqual([
      second,
    ]);
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-b']).toHaveLength(
      1
    );
  });

  it('publishes exact composer drafts by thread without persistence', () => {
    useAssistantComposerCommandStore.getState().recordDraft('thread-a', 'Working draft');
    useAssistantComposerCommandStore.getState().recordDraft('thread-b', 'Other draft');

    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId).toEqual({
      'thread-a': 'Working draft',
      'thread-b': 'Other draft',
    });
  });

  it('rejects empty commands instead of silently queueing unusable work', () => {
    expect(() =>
      useAssistantComposerCommandStore.getState().enqueue({
        mode: 'append',
        text: '   ',
        threadId: 'thread-a',
      })
    ).toThrow(/non-whitespace text/i);
  });
});
