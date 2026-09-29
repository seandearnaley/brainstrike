/**
 * The Stop re-read's draft carry, on its own (BST-1749, PR #3214 review).
 *
 * The carry runs inside the SETTLED cancel's continuation, whose only catch
 * reports a failed cancel. Throwing there would report a false failure for a
 * cancel that succeeded, after the key bump already happened — so "no thread"
 * and "no draft" both return quietly, and only a real draft is enqueued.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useStopRereadDraftCarry } from '../use-stop-reread-draft-carry';

describe('useStopRereadDraftCarry', () => {
  beforeEach(() => {
    useAssistantComposerCommandStore.getState().reset();
  });

  it('carries this thread’s recorded draft as a replace command', () => {
    useAssistantComposerCommandStore.getState().recordDraft('thread-a', 'Read only the manifest');
    const { result } = renderHook(() => useStopRereadDraftCarry('thread-a'));

    result.current();

    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-a']
    ).toMatchObject([{ mode: 'replace', text: 'Read only the manifest', threadId: 'thread-a' }]);
  });

  it('returns quietly without a thread, rather than throwing into the settled cancel', () => {
    const { result } = renderHook(() => useStopRereadDraftCarry(undefined));

    expect(() => result.current()).not.toThrow();
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });

  it('carries nothing when the composer held only whitespace', () => {
    useAssistantComposerCommandStore.getState().recordDraft('thread-a', '   ');
    const { result } = renderHook(() => useStopRereadDraftCarry('thread-a'));

    result.current();

    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });
});
