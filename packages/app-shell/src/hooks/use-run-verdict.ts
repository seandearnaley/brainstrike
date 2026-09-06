import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { RunVerdictContextValue } from '@brainstrike/assistant-ui';
import { useMemo } from 'react';

/**
 * Binds the assistant panel's per-run 👍/👎 control to the Task Ledger:
 * `recordRunOutcome` with `source: 'user'` (a user verdict deliberately upserts
 * over a derived `edit_revert` label). Gates on the repository EXISTING plus the
 * active resource/thread — `recordRunOutcome` itself is no longer optional
 * (BST-1651), so the affordance can no longer disappear because of a shape
 * mismatch. Unlike the checkpoint bridge this is not desktop-only: it works
 * wherever the PGlite repository exists. Persistence failures propagate so the
 * control shows a visible retry (never a silent drop).
 */
export function useRunVerdictBinding(
  repository: AssistantThreadRepository | null,
  resourceId: string | null | undefined,
  threadId: string | null | undefined
): RunVerdictContextValue | null {
  return useMemo(() => {
    if (!(repository && resourceId && threadId)) {
      return null;
    }
    const { recordRunOutcome } = repository;
    return {
      recordVerdict: async (runId, verdict) => {
        await recordRunOutcome({
          labeledAt: new Date(),
          resourceId,
          runId,
          source: 'user',
          threadId,
          verdict,
        });
      },
    };
  }, [repository, resourceId, threadId]);
}
