import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import type { EditCheckpointContextValue } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantThreadRepository } from '../assistant-memory-repository';

const logger = createLogger('EditCheckpoints');

export interface EditCheckpointsBinding {
  /**
   * The checkpoint context for the active thread, or `null` when the bridge is
   * absent (web / not desktop) or no thread is selected — capability gating.
   */
  readonly checkpoints: EditCheckpointContextValue | null;
  /**
   * Re-read the journal for the active thread. Invoke it on run completion so a
   * checkpoint journaled during the turn that JUST ran surfaces without a thread
   * switch or reload.
   */
  readonly refetch: () => Promise<void>;
}

/**
 * Sources the edit-checkpoint binding for the active thread. Reads journal
 * entries via the repository (Path A) and reverts through the desktop
 * `window.assistantCheckpoints` IPC bridge, refetching on a successful revert.
 * Exposes `refetch` so the caller can re-read on run completion (the journal is
 * written in main during tool execution, after the last thread-open read).
 */
export function useEditCheckpoints(
  repository: AssistantThreadRepository | null,
  threadId: string | null | undefined
): EditCheckpointsBinding {
  const [entries, setEntries] = useState<readonly AssistantEditCheckpointRecord[]>([]);
  const bridge = typeof window === 'undefined' ? undefined : window.assistantCheckpoints;
  const revertEntryBridge = bridge?.revertEntry;
  const revertRunBridge = bridge?.revertRun;
  // Monotonic generation so a slow refetch resolving after a newer one (e.g. a
  // mid-revert thread switch) can never clobber the fresher entries.
  const generationRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!(repository && threadId)) {
      if (generation === generationRef.current) {
        setEntries([]);
      }
      return;
    }
    try {
      const next = await repository.listThreadCheckpoints(threadId);
      if (generation === generationRef.current) {
        setEntries(next);
      }
    } catch (error) {
      logger.error('Failed to load edit checkpoints for the active thread', { error });
      if (generation === generationRef.current) {
        setEntries([]);
      }
    }
  }, [repository, threadId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const checkpoints = useMemo<EditCheckpointContextValue | null>(() => {
    if (!(revertEntryBridge && revertRunBridge && repository && threadId)) {
      return null;
    }
    const entriesByToolCallId = new Map<string, AssistantEditCheckpointRecord>();
    for (const entry of entries) {
      if (entry.toolCallId) {
        entriesByToolCallId.set(entry.toolCallId, entry);
      }
    }
    return {
      entries,
      entriesByToolCallId,
      revertEntry: async (id, options) => {
        const result = await revertEntryBridge(id, options);
        if (result.ok) {
          await refetch();
        }
        return result;
      },
      revertRun: async (runId, options) => {
        try {
          const result = await revertRunBridge(runId, options);
          // Refetch when anything actually reverted; a conflict-only run changed
          // nothing on disk, so the stale list would be identical (and a
          // conflicting entry must stay revertible so "Revert anyway" can force it).
          if (result.outcomes.some((outcome) => outcome.ok)) {
            await refetch();
          }
          return result;
        } catch (error) {
          // An unexpected executor throw may have partially reverted on disk
          // before aborting: refetch so the per-entry/turn controls reconcile,
          // then rethrow so the control shows a visible failure.
          await refetch();
          throw error;
        }
      },
    };
  }, [entries, refetch, repository, revertEntryBridge, revertRunBridge, threadId]);

  return { checkpoints, refetch };
}
