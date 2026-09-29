import { useCallback } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';

/**
 * Carries the live composer draft across the root Stop re-read (BST-1749).
 *
 * A Stop that cancelled an undecided pause re-reads history by REMOUNTING the
 * panel's runtime, which discards the live composer. This hands the thread's
 * recorded draft back through the SAME thread-scoped command channel the
 * prompt library uses, so it lands in this thread's new mount and in no other
 * open thread (owner ruling 2026-09-15). The thread id is captured here, so a
 * switch while the cancel settles cannot move the draft.
 *
 * Only the TEXT draft travels: composer attachments and other per-mount state
 * are still discarded by the remount.
 */
export function useStopRereadDraftCarry(threadId: string | undefined): () => void {
  const enqueue = useAssistantComposerCommandStore((state) => state.enqueue);
  return useCallback(() => {
    if (!threadId) {
      // No thread means no recorded draft to carry. The caller runs inside the
      // SETTLED cancel's continuation, whose only catch reports a failed
      // cancel — throwing here would report a false failure for a cancel that
      // succeeded, after the key bump already happened (PR #3214 review).
      return;
    }
    const draft = useAssistantComposerCommandStore.getState().draftTextByThreadId[threadId] ?? '';
    if (draft.trim() === '') {
      return;
    }
    enqueue({ mode: 'replace', text: draft, threadId });
  }, [enqueue, threadId]);
}
