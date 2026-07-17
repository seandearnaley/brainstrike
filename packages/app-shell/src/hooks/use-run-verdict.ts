import type { RunVerdictContextValue } from '@brainstrike/ui/assistant-ui-panel';
import { useMemo } from 'react';
import type { AssistantThreadRepository } from '../assistant-memory-repository';

/**
 * Binds the assistant panel's per-run 👍/👎 control to the Task Ledger:
 * `recordRunOutcome` with `source: 'user'` (a user verdict deliberately upserts
 * over a derived `edit_revert` label). Gates on the repository's OPTIONAL
 * `recordRunOutcome` capability plus the active resource/thread — unlike the
 * checkpoint bridge this is not desktop-only: it works wherever the PGlite
 * repository exists. Persistence failures propagate so the control shows a
 * visible retry (never a silent drop).
 */
export function useRunVerdictBinding(
  repository: AssistantThreadRepository | null,
  resourceId: string | null | undefined,
  threadId: string | null | undefined
): RunVerdictContextValue | null {
  return useMemo(() => {
    const recordRunOutcome = repository?.recordRunOutcome;
    if (!(recordRunOutcome && resourceId && threadId)) {
      return null;
    }
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
