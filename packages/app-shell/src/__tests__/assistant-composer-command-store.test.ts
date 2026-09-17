import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('publishes exact composer drafts by thread', () => {
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
  it('restores only unsent text through thread-scoped commands after renderer reload', async () => {
    const state = useAssistantComposerCommandStore.getState();
    state.recordDraft('root', 'Unsent root draft');
    state.recordDraft('child', 'Different child draft');
    state.enqueue({ mode: 'append', text: 'Not applied yet', threadId: 'root' });
    vi.resetModules();
    const { useAssistantComposerCommandStore: reloaded } = await import(
      '../assistant-composer-command-store'
    );
    expect(reloaded.getState().commandsByThreadId['root']).toEqual([
      expect.objectContaining({ mode: 'replace', text: 'Unsent root draft', threadId: 'root' }),
    ]);
    expect(reloaded.getState().commandsByThreadId['child']).toEqual([
      expect.objectContaining({
        mode: 'replace',
        text: 'Different child draft',
        threadId: 'child',
      }),
    ]);
    reloaded.getState().recordDraft('root', '');
    vi.resetModules();
    const { useAssistantComposerCommandStore: afterSend } = await import(
      '../assistant-composer-command-store'
    );
    expect(afterSend.getState().commandsByThreadId['root']).toBeUndefined();
    afterSend.getState().reset();
    vi.resetModules();
    const { useAssistantComposerCommandStore: afterReset } = await import(
      '../assistant-composer-command-store'
    );
    expect(afterReset.getState().draftTextByThreadId).toEqual({});
    expect(afterReset.getState().commandsByThreadId).toEqual({});
  });
  it('starts empty when this session has no saved draft', async () => {
    sessionStorage.removeItem('assistant-composer-drafts.v1');
    vi.resetModules();
    const { useAssistantComposerCommandStore: fresh } = await import(
      '../assistant-composer-command-store'
    );
    expect(fresh.getState().draftTextByThreadId).toEqual({});
    expect(fresh.getState().commandsByThreadId).toEqual({});
  });
});
