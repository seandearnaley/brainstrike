import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import type { EditCheckpointContextValue } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssistantThreadRepository } from '../assistant-memory-repository';

const logger = createLogger('EditCheckpoints');

/**
 * Sources the edit-checkpoint context for the active thread. Reads journal
 * entries via the repository (Path A) and reverts through the desktop
 * `window.assistantCheckpoints` IPC bridge, refetching on a successful revert.
 *
 * Returns `null` when the bridge is absent (web / not desktop) or no thread is
 * selected — capability gating, so the UI renders no Revert control there.
 */
export function useEditCheckpoints(
  repository: AssistantThreadRepository | null,
  threadId: string | null | undefined
): EditCheckpointContextValue | null {
  const [entries, setEntries] = useState<readonly AssistantEditCheckpointRecord[]>([]);
  const bridge = typeof window === 'undefined' ? undefined : window.assistantCheckpoints;
  const revertEntryBridge = bridge?.revertEntry;

  const refetch = useCallback(async (): Promise<void> => {
    if (!(repository && threadId)) {
      setEntries([]);
      return;
    }
    try {
      setEntries(await repository.listThreadCheckpoints(threadId));
    } catch (error) {
      logger.error('Failed to load edit checkpoints for the active thread', { error });
      setEntries([]);
    }
  }, [repository, threadId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return useMemo<EditCheckpointContextValue | null>(() => {
    if (!(revertEntryBridge && repository && threadId)) {
      return null;
    }
    const entriesByToolCallId = new Map<string, AssistantEditCheckpointRecord>();
    for (const entry of entries) {
      if (entry.toolCallId) {
        entriesByToolCallId.set(entry.toolCallId, entry);
      }
    }
    return {
      entriesByToolCallId,
      revertEntry: async (id, options) => {
        const result = await revertEntryBridge(id, options);
        if (result.ok) {
          await refetch();
        }
        return result;
      },
    };
  }, [entries, refetch, repository, revertEntryBridge, threadId]);
}
