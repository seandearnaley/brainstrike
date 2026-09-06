import {
  type AssistantCheckpointUndoAvailability,
  type AssistantEditCheckpointRecord,
  isRevertibleCaptureStatus,
} from '@brainstrike/assistant-contract';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { EditCheckpointContextValue } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('EditCheckpoints');

/**
 * Derive and record the run's outcome label from the POST-revert journal
 * (Task Ledger `edit_revert` source): every revertible edit reverted = the
 * user rejected the run's work outright (`failed`); a partial revert =
 * `mixed`. Labeling is SECONDARY to the revert itself — a failure here is
 * logged and never rejects the completed revert (mirrors the non-fatal
 * checkpoint-capture contract). A later explicit user verdict upserts over
 * this derived label by design.
 */
async function labelRunOutcomeFromJournal(
  repository: AssistantThreadRepository,
  runId: string,
  entries: readonly AssistantEditCheckpointRecord[]
): Promise<void> {
  const runEntries = entries.filter(
    (entry) => entry.runId === runId && isRevertibleCaptureStatus(entry.captureStatus)
  );
  const anchor = runEntries[0];
  if (!anchor) {
    return;
  }
  const revertedCount = runEntries.filter((entry) => entry.revertedAt !== null).length;
  if (revertedCount === 0) {
    return;
  }
  try {
    await repository.recordRunOutcome({
      detail: `${revertedCount}/${runEntries.length} edits reverted`,
      labeledAt: new Date(),
      resourceId: anchor.resourceId,
      runId,
      source: 'edit_revert',
      threadId: anchor.threadId,
      verdict: revertedCount === runEntries.length ? 'failed' : 'mixed',
    });
  } catch (error) {
    logger.error('Failed to record revert-derived run outcome', { error, runId });
  }
}

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
  const [availabilityById, setAvailabilityById] = useState<
    ReadonlyMap<string, AssistantCheckpointUndoAvailability>
  >(new Map());
  const bridge = typeof window === 'undefined' ? undefined : window.assistantCheckpoints;
  const availabilityBridge = bridge?.availability;
  const revertEntryBridge = bridge?.revertEntry;
  const revertRunBridge = bridge?.revertRun;
  // Monotonic generation so a slow refetch resolving after a newer one (e.g. a
  // mid-revert thread switch) can never clobber the fresher entries.
  const generationRef = useRef(0);

  const loadEntries = useCallback(async (): Promise<readonly AssistantEditCheckpointRecord[]> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!(repository && threadId)) {
      if (generation === generationRef.current) {
        setEntries([]);
        setAvailabilityById(new Map());
      }
      return [];
    }
    try {
      const next = await repository.listThreadCheckpoints(threadId);
      // Snapshot availability rides every entries load (BST-1164 T4): the
      // undo controls render disabled-with-reason from this map. A fetch
      // failure clears the map — `availabilityForEntry`'s fail-safe then
      // renders every control disabled with a visible generic reason, which
      // matches what a click would do; it never silently enables.
      let nextAvailability: ReadonlyMap<string, AssistantCheckpointUndoAvailability> = new Map();
      if (availabilityBridge && next.length > 0) {
        try {
          const result = await availabilityBridge(threadId);
          nextAvailability = new Map(Object.entries(result.byCheckpointId));
        } catch (error) {
          logger.error('Failed to load checkpoint undo availability', { error });
        }
      }
      if (generation === generationRef.current) {
        setEntries(next);
        setAvailabilityById(nextAvailability);
      }
      return next;
    } catch (error) {
      logger.error('Failed to load edit checkpoints for the active thread', { error });
      if (generation === generationRef.current) {
        setEntries([]);
        setAvailabilityById(new Map());
      }
      return [];
    }
  }, [availabilityBridge, repository, threadId]);

  const refetch = useCallback(async (): Promise<void> => {
    await loadEntries();
  }, [loadEntries]);

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
      availabilityById,
      entries,
      entriesByToolCallId,
      revertEntry: async (id, options) => {
        const result = await revertEntryBridge(id, options);
        if (result.ok) {
          const fresh = await loadEntries();
          await labelRunOutcomeFromJournal(repository, result.entry.runId, fresh);
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
            const fresh = await loadEntries();
            await labelRunOutcomeFromJournal(repository, runId, fresh);
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
  }, [
    availabilityById,
    entries,
    loadEntries,
    refetch,
    repository,
    revertEntryBridge,
    revertRunBridge,
    threadId,
  ]);

  return { checkpoints, refetch };
}
